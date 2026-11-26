"""Single-operation grants; never infer permission from chat or workspace roles."""
import hashlib
import json
from datetime import datetime, timezone
from sqlalchemy import select, update
from app.models import DirectThreadLink, WorkspaceMember
from app.services.agent_conversations import agent_owner, takeover_active


def now():
    return datetime.now(timezone.utc)


def digest(operation):
    return hashlib.sha256(json.dumps(operation, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def current_owner(db, row):
    member = db.execute(select(WorkspaceMember).where(
        WorkspaceMember.workspace_id == row.workspace_id, WorkspaceMember.agent_name == row.agent_name)
        .with_for_update().execution_options(populate_existing=True)).scalar_one_or_none()
    if not member or member.status == 'removed':
        return None
    return (member.owner_email or '').strip().lower() or None


def refresh(db, row):
    if row.status in ('pending', 'approved'):
        if current_owner(db, row) != row.owner_email:
            status = 'invalidated'
        elif row.expires_at.replace(tzinfo=timezone.utc) <= now():
            status = 'expired'
        else:
            return
        db.execute(update(type(row)).where(type(row).id == row.id, type(row).status.in_(('pending', 'approved'))).values(status=status))
        db.refresh(row)


def paused(db, row):
    link = db.execute(select(DirectThreadLink).where(DirectThreadLink.workspace_id == row.workspace_id,
        DirectThreadLink.session_key == row.session_id)).scalar_one_or_none()
    return takeover_active(current_owner(db, row), link.takeover_owner if link else None)


def visible(db, row, viewer):
    if viewer.kind == 'human':
        return bool(viewer.email and viewer.email in (row.visitor_email, agent_owner(db, row.workspace_id, 'openagents:' + row.agent_name)))
    return viewer.kind == 'agent' and viewer.agent_name == row.agent_name


def serialize(db, row, viewer):
    return {**{key: getattr(row, key) for key in ('id', 'session_id', 'agent_name', 'owner_email',
        'visitor_email', 'operation', 'operation_digest', 'status', 'result')},
        'created_at': row.created_at.isoformat(), 'expires_at': row.expires_at.isoformat(),
        'paused': paused(db, row),
        'can_decide': viewer.kind == 'human' and viewer.email == current_owner(db, row) and row.status == 'pending',
        'can_withdraw': viewer.kind == 'human' and viewer.email == row.visitor_email and row.status in ('pending', 'approved')}
