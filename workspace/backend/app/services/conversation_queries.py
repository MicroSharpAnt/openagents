"""Exact DM summaries with indexed history reads and batched detail lookups."""
from sqlalchemy import and_, case, func, literal_column, or_, select

from app.models import EventRecord
from app.services.agent_conversations import conversation_source, pair_filter


def _columns(events):
    e = events.c
    source = conversation_source(events)
    return (case((source <= e.target, source), else_=e.target),
            case((source > e.target, source), else_=e.target))


def _scope(events, workspace_id):
    e = events.c
    return (
        e.network_id == workspace_id,
        # Static literals let PostgreSQL use the partial index even with a
        # generic prepared plan. No caller input is interpolated here.
        e.visibility == literal_column("'direct'"),
        e.type == literal_column("'workspace.message.posted'"),
        func.lower(e.source) != 'human:system',
        func.lower(e.target) != 'human:system',
        ~e.target.startswith('channel/'),
    )


def conversation_pairs_query(workspace_id, limit, agent=None, visibility_filters=(), *, events=None):
    events = events if events is not None else EventRecord.__table__
    e = events.c
    a, b = _columns(events)
    query = select(a.label('agent_a'), b.label('agent_b'),
                   func.max(e.timestamp).label('last_ts'), func.count().label('msg_count')).where(
        *_scope(events, workspace_id), *visibility_filters)
    if agent:
        query = query.where(or_(conversation_source(events) == agent, e.target == agent))
    # Count the complete history, including legacy pairs without a thread-link
    # row. The partial covering index avoids reading channel messages/payloads.
    return query.group_by(a, b).order_by(func.max(e.timestamp).desc(), a, b).limit(limit)


def conversation_detail_queries(workspace_id, pairs, read_markers, own_addresses, cutoff, *, events=None, sender_addresses=None):
    """At most two queries, independent of the number of returned pairs."""
    if not pairs:
        return None, None
    events = events if events is not None else EventRecord.__table__
    e = events.c
    a, b = _columns(events)
    latest_filters, unread_filters = [], []
    for row in pairs:
        pair = pair_filter(events, row.agent_a, row.agent_b)
        latest_filters.append(and_(pair, e.timestamp == row.last_ts))
        marker = read_markers.get(f'dm:{row.agent_a},{row.agent_b}')
        if marker is not None:
            unread_filters.append(and_(pair, e.timestamp > marker))

    # Rank narrow IDs only, then fetch the winning payload. Timestamp ties
    # have a stable ID tie-break and cannot duplicate a conversation.
    ranked = select(e.id, a.label('agent_a'), b.label('agent_b'),
                    func.row_number().over(partition_by=(a, b), order_by=e.id.desc()).label('rn')).where(
        *_scope(events, workspace_id), or_(*latest_filters)).subquery()
    latest = select(ranked.c.agent_a, ranked.c.agent_b, e.source, e.payload, e.timestamp).join(
        ranked, e.id == ranked.c.id).where(ranked.c.rn == 1)
    unread = None
    if unread_filters:
        unread = select(a.label('agent_a'), b.label('agent_b'), func.count().label('unread_count')).where(
            *_scope(events, workspace_id), or_(*unread_filters), e.timestamp >= cutoff,
            or_(e.target.in_(own_addresses), conversation_source(events).in_(own_addresses)),
            ~e.source.in_(sender_addresses if sender_addresses is not None else own_addresses),
            or_(e.payload['message_type'].as_string().is_(None),
                e.payload['message_type'].as_string().notin_(['thinking', 'status', 'todos'])),
        ).group_by(a, b)
    return latest, unread
