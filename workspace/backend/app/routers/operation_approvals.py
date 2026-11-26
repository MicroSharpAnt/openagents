"""Authenticated, private operation approval HTTP boundary."""
from datetime import timedelta
from pathlib import PurePosixPath
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.routing import APIRoute
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_core import PydanticCustomError
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import OperationApproval
from app.response import success_response, json_response
from app.routers.network import _resolve_workspace
from app.services import operation_approvals as svc
from app.services.agent_conversations import visitor_pair, agent_owner, lock_conversation
from app.services.visibility import resolve_viewer

class OperationRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def wrapped(request):
            try:
                return await handler(request)
            except HTTPException as exc:
                return json_response(exc.status_code, str(exc.detail))
            except RequestValidationError:
                # Never log a submitted execution token or sensitive operation paths.
                return json_response(422, 'Invalid operation approval request')
        return wrapped


router = APIRouter(prefix='/v1/operation-approvals', tags=['Operation approvals'], route_class=OperationRoute)


class Operation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: Literal['move']
    root: str = Field(min_length=1, max_length=4096)
    source: str = Field(min_length=1, max_length=4096)
    destination: str = Field(min_length=1, max_length=4096)
    expected_state: str = Field(pattern=r'^[0-9a-f]{64}$')

    @field_validator('root', 'source', 'destination')
    @classmethod
    def valid_path(cls, value, info):
        path = PurePosixPath(value)
        if '\x00' in value or '\\' in value or '..' in path.parts or str(path) != value:
            raise PydanticCustomError('path_scope', 'Paths must be canonical and cannot traverse parents')
        if (info.field_name == 'root') != path.is_absolute() or value in ('.', ''):
            raise PydanticCustomError('path_scope', 'Root must be absolute; operation paths must be relative')
        return value


class Create(BaseModel):
    network: str
    session_id: str
    request_key: str = Field(min_length=1, max_length=200)
    operation: Operation


def actor(network, db, token, authorization, agent):
    ws = _resolve_workspace(db, network)
    if not ws:
        raise HTTPException(404, 'Network not found')
    viewer = resolve_viewer(db, ws, token, authorization, agent_name=agent)
    if not ((viewer.kind == 'human' and viewer.email and viewer.role) or viewer.kind == 'agent'):
        raise HTTPException(403, 'Authenticated member or named connector required')
    return ws, viewer


def context_data(db, ws, viewer, session_id):
    pair = visitor_pair(session_id)
    if viewer.kind != 'agent' or not pair or pair.session_id != session_id or pair.agent_address != 'openagents:' + viewer.agent_name:
        raise HTTPException(403, 'Connector conversation mismatch')
    owner = agent_owner(db, ws.id, pair.agent_address)
    if not owner:
        raise HTTPException(403, 'Active owned agent required')
    visitor = pair.visitor_address[6:]
    from app.services.access_model import role_for_email
    if visitor != visitor.strip().lower() or not role_for_email(db, ws, visitor):
        raise HTTPException(403, 'Current visitor membership required')
    row = OperationApproval(workspace_id=str(ws.id), session_id=pair.session_id, agent_name=viewer.agent_name)
    return {'required': visitor != owner, 'owner_email': owner, 'visitor_email': visitor, 'paused': svc.paused(db, row)}


@router.get('/context')
def context(network: str, session_id: str, db: Session = Depends(get_db), x_workspace_token: str | None = Header(None),
            authorization: str | None = Header(None), x_agent_name: str | None = Header(None)):
    ws, viewer = actor(network, db, x_workspace_token, authorization, x_agent_name)
    return success_response(context_data(db, ws, viewer, session_id))


@router.post('')
def create(body: Create, db: Session = Depends(get_db), x_workspace_token: str | None = Header(None),
           authorization: str | None = Header(None), x_agent_name: str | None = Header(None)):
    ws, viewer = actor(body.network, db, x_workspace_token, authorization, x_agent_name)
    ctx = context_data(db, ws, viewer, body.session_id)
    operation = body.operation.model_dump()
    if operation['destination'] == operation['source'] or operation['destination'].startswith(operation['source'] + '/'):
        raise HTTPException(422, 'Cannot move into itself')
    lock_conversation(db, ws.id, body.session_id)
    query = select(OperationApproval).where(OperationApproval.workspace_id == str(ws.id),
        OperationApproval.agent_name == viewer.agent_name, OperationApproval.request_key == body.request_key)
    row = db.execute(query).scalar_one_or_none()
    if row is None:
        row = OperationApproval(workspace_id=str(ws.id), session_id=body.session_id, agent_name=viewer.agent_name,
            owner_email=ctx['owner_email'], visitor_email=ctx['visitor_email'], request_key=body.request_key,
            operation=operation, operation_digest=svc.digest(operation), expires_at=svc.now() + timedelta(minutes=30))
        db.add(row)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            row = db.execute(query).scalar_one()
    if row.session_id != body.session_id or row.operation != operation:
        raise HTTPException(409, 'Request key already used for different operation')
    svc.refresh(db, row)
    db.commit()
    return success_response(svc.serialize(db, row, viewer))


def load(db, ws, viewer, approval_id):
    row = db.get(OperationApproval, approval_id)
    if row is None or row.workspace_id != str(ws.id) or not svc.visible(db, row, viewer):
        raise HTTPException(404, 'Operation approval not found')
    lock_conversation(db, ws.id, row.session_id)
    db.refresh(row, with_for_update=True)
    svc.refresh(db, row)
    if not svc.visible(db, row, viewer):
        raise HTTPException(404, 'Operation approval not found')
    return row


@router.get('')
def listing(network: str, session_id: str | None = None, db: Session = Depends(get_db),
            x_workspace_token: str | None = Header(None), authorization: str | None = Header(None),
            x_agent_name: str | None = Header(None)):
    ws, viewer = actor(network, db, x_workspace_token, authorization, x_agent_name)
    query = select(OperationApproval).where(OperationApproval.workspace_id == str(ws.id))
    if session_id:
        query = query.where(OperationApproval.session_id == session_id)
    rows = db.execute(query.order_by(OperationApproval.created_at.desc())).scalars().all()
    out = []
    for row in rows:
        if svc.visible(db, row, viewer):
            row = load(db, ws, viewer, row.id)
            out.append(svc.serialize(db, row, viewer))
            db.commit()
    return success_response({'requests': out, 'pending_count': sum(r['can_decide'] for r in out)})


@router.get('/{approval_id}')
def get(approval_id: str, network: str, db: Session = Depends(get_db),
        x_workspace_token: str | None = Header(None), authorization: str | None = Header(None),
        x_agent_name: str | None = Header(None)):
    ws, viewer = actor(network, db, x_workspace_token, authorization, x_agent_name)
    row = load(db, ws, viewer, approval_id)
    result = svc.serialize(db, row, viewer)
    db.commit()
    return success_response(result)


class Decision(BaseModel):
    network: str
    decision: Literal['approve', 'reject', 'withdraw']


@router.post('/{approval_id}/decision')
def decision(approval_id: str, body: Decision, db: Session = Depends(get_db),
             x_workspace_token: str | None = Header(None), authorization: str | None = Header(None),
             x_agent_name: str | None = Header(None)):
    ws, viewer = actor(body.network, db, x_workspace_token, authorization, x_agent_name)
    row = load(db, ws, viewer, approval_id)
    allowed = row.visitor_email if body.decision == 'withdraw' else svc.current_owner(db, row)
    if viewer.kind != 'human' or viewer.email != allowed:
        db.commit()
        raise HTTPException(403, 'Only the designated human may decide')
    statuses = ('pending', 'approved') if body.decision == 'withdraw' else ('pending',)
    if row.status not in statuses:
        db.commit()
        raise HTTPException(409, 'Operation is already ' + row.status)
    changed = db.execute(update(OperationApproval).where(OperationApproval.id == row.id,
        OperationApproval.status.in_(statuses)).values(
            status={'approve': 'approved', 'reject': 'rejected', 'withdraw': 'withdrawn'}[body.decision]))
    db.commit()
    if changed.rowcount != 1:
        raise HTTPException(409, 'Operation state changed')
    db.refresh(row)
    return success_response(svc.serialize(db, row, viewer))


class Claim(BaseModel):
    network: str
    operation_digest: str


class Result(BaseModel):
    network: str
    execution_token: str
    status: Literal['succeeded', 'failed', 'invalidated']
    result: dict | str | None = None


@router.post('/{approval_id}/claim')
def claim(approval_id: str, body: Claim, db: Session = Depends(get_db),
          x_workspace_token: str | None = Header(None), authorization: str | None = Header(None),
          x_agent_name: str | None = Header(None)):
    import hashlib
    import secrets
    from sqlalchemy import update
    ws, viewer = actor(body.network, db, x_workspace_token, authorization, x_agent_name)
    row = load(db, ws, viewer, approval_id)
    if viewer.kind != 'agent' or viewer.agent_name != row.agent_name:
        raise HTTPException(403, 'Only requesting connector may claim')
    if row.status != 'approved' or body.operation_digest != row.operation_digest or svc.paused(db, row):
        db.commit()
        raise HTTPException(409, 'Operation is not executable')
    token = secrets.token_urlsafe(32)
    # CAS remains essential on SQLite, which does not implement row locks.
    claimed = db.execute(update(OperationApproval).where(OperationApproval.id == row.id,
        OperationApproval.status == 'approved', OperationApproval.execution_token_hash.is_(None))
        .values(status='executing', execution_token_hash=hashlib.sha256(token.encode()).hexdigest()))
    if claimed.rowcount != 1:
        db.rollback()
        raise HTTPException(409, 'Operation already claimed')
    db.commit()
    db.refresh(row)
    return success_response({**svc.serialize(db, row, viewer), 'execution_token': token})


@router.post('/{approval_id}/result')
def result(approval_id: str, body: Result, db: Session = Depends(get_db),
           x_workspace_token: str | None = Header(None), authorization: str | None = Header(None),
           x_agent_name: str | None = Header(None)):
    import hashlib
    import secrets
    ws, viewer = actor(body.network, db, x_workspace_token, authorization, x_agent_name)
    row = load(db, ws, viewer, approval_id)
    if (viewer.kind != 'agent' or viewer.agent_name != row.agent_name or not row.execution_token_hash
            or not secrets.compare_digest(row.execution_token_hash, hashlib.sha256(body.execution_token.encode()).hexdigest())):
        raise HTTPException(403, 'Original execution token required')
    if row.status != 'executing':
        if row.status != body.status or row.result != body.result:
            raise HTTPException(409, 'Completion already recorded')
    else:
        changed = db.execute(update(OperationApproval).where(OperationApproval.id == row.id,
            OperationApproval.status == 'executing').values(status=body.status, result=body.result))
        db.commit()
        db.refresh(row)
        if changed.rowcount != 1 and (row.status != body.status or row.result != body.result):
            raise HTTPException(409, 'Completion already recorded')
    return success_response(svc.serialize(db, row, viewer))
