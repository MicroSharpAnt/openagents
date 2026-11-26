"""Canonical visitor conversations with authenticated owner participation.

The event source remains the real human. Only server-authorized owner messages
carry dm_agent, which substitutes for source when grouping the conversation.
"""
from typing import NamedTuple

from sqlalchemy import and_, func, or_, select

from app.models import WorkspaceMember
from openagents.core.onm_mods import EventRejected


def conversation_source(events):
    return func.coalesce(events.c.metadata['dm_agent'].as_string(), events.c.source)


def pair_filter(events, a, b):
    source, target = conversation_source(events), events.c.target
    return or_(and_(source == a, target == b), and_(source == b, target == a))


class VisitorConversation(NamedTuple):
    visitor_address: str
    agent_address: str

    @property
    def session_id(self):
        return 'dm:' + ','.join(sorted(self))


def takeover_active(owner, takeover_owner):
    return bool(owner and takeover_owner == owner)


def state_fields(owner, viewer, takeover_owner):
    return {'owner_email': owner or None,
            'can_manage': bool(owner and viewer.kind == 'human' and viewer.email == owner),
            'paused': takeover_active(owner, takeover_owner)}


def visitor_pair(session_id):
    if not isinstance(session_id, str) or not session_id.startswith('dm:'):
        return None
    parts = session_id[3:].split(',')
    if len(parts) != 2:
        return None
    humans = [p for p in parts if p.startswith('human:') and '@' in p]
    agents = [p for p in parts if p.startswith('openagents:') and p[11:]]
    return VisitorConversation(humans[0], agents[0]) if len(humans) == len(agents) == 1 else None


def agent_owner(db, workspace_id, address):
    member = db.get(WorkspaceMember, (str(workspace_id), address[len('openagents:'):]))
    if not member or member.status == 'removed':
        return None
    return (member.owner_email or '').strip().lower() or None


def prepare_message(event, ctx):
    """Validate an owner reply before any routing or persistence, on every writer."""
    # Address-to-address messages stay private even when a client omits visibility.
    if event.source.startswith(('human:', 'openagents:')) and event.target.startswith(('human:', 'openagents:')):
        event.visibility = 'direct'
    metadata = event.metadata
    requested = metadata.pop('dm_conversation', None)
    metadata.pop('dm_agent', None)
    metadata.pop('dm_owner', None)
    if not requested:
        enforce_takeover(event, ctx)
        return
    db, workspace = ctx.extra['db'], ctx.extra['workspace']
    from app.services.visibility import resolve_viewer
    bearer = ctx.extra.get('bearer_token')
    viewer = resolve_viewer(db, workspace, ctx.extra.get('token'), f'Bearer {bearer}' if bearer else None)
    pair = visitor_pair(requested)
    if (not pair or viewer.kind != 'human' or not viewer.email
            or agent_owner(db, workspace.id, pair.agent_address) != viewer.email
            or str(getattr(event.visibility, 'value', event.visibility)) != 'direct'
            or event.target != pair.visitor_address):
        raise EventRejected('workspace_mod', 'agent_conversation_forbidden')
    event.source = f'human:{viewer.email}'
    event.payload = {**(event.payload or {}), 'sender_email': viewer.email, 'sender_id': viewer.email}
    metadata.update(dm_agent=pair.agent_address, dm_owner=viewer.email,
                    dm_conversation=pair.session_id, target_agents=['__no_response__'])


def lock_conversation(db, workspace_id, session_id):
    # Also serialize the first message/takeover, before a thread-link row exists.
    if db.get_bind().dialect.name == 'postgresql':
        import hashlib
        from sqlalchemy import text
        key = int.from_bytes(hashlib.sha256(f'dm:{workspace_id}:{session_id}'.encode()).digest()[:8], 'big', signed=True)
        db.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': key})


def conversation_state(db, workspace_id, viewer, session_id):
    from app.models import DirectThreadLink
    pair = visitor_pair(session_id)
    if not pair:
        return None
    owner = agent_owner(db, workspace_id, pair.agent_address)
    email = viewer.email if viewer.kind == 'human' else None
    if not email or (f'human:{email}' != pair.visitor_address and email != owner):
        return None
    key = pair.session_id
    link = db.execute(select(DirectThreadLink).where(DirectThreadLink.workspace_id == str(workspace_id),
        DirectThreadLink.session_key == key)).scalar_one_or_none()
    return {'session_id': key, **state_fields(owner, viewer, link.takeover_owner if link else None)}


def enforce_takeover(event, ctx):
    from app.models import DirectThreadLink
    if str(getattr(event.visibility, 'value', event.visibility)) != 'direct':
        return
    pair = visitor_pair('dm:' + ','.join(sorted([event.source, event.target])))
    if not pair:
        return
    db, workspace = ctx.extra['db'], ctx.extra['workspace']
    key = pair.session_id
    lock_conversation(db, workspace.id, key)
    link = db.execute(select(DirectThreadLink).where(DirectThreadLink.workspace_id == str(workspace.id),
        DirectThreadLink.session_key == key)).scalar_one_or_none()
    owner = agent_owner(db, workspace.id, pair.agent_address)
    if not takeover_active(owner, link.takeover_owner if link else None):
        return
    if event.source == pair.agent_address:
        raise EventRejected('workspace_mod', 'agent_conversation_paused_forbidden')
    event.metadata['target_agents'] = ['__no_response__']
