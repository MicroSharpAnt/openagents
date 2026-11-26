"""Private immutable one-operation grants.

Revision ID: 104
Revises: 103
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision = '104'
down_revision = '103'
branch_labels = None
depends_on = None
deployment_backward_compatible = True


def upgrade():
    op.create_table('operation_approvals',
        sa.Column('id', sa.Text(), primary_key=True),
        sa.Column('workspace_id', postgresql.UUID(as_uuid=False), sa.ForeignKey('workspaces.id', ondelete='CASCADE'), nullable=False),
        *[sa.Column(name, sa.Text(), nullable=False) for name in (
            'session_id', 'agent_name', 'owner_email', 'visitor_email', 'request_key', 'operation_digest', 'status')],
        sa.Column('operation', postgresql.JSONB(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('execution_token_hash', sa.Text()),
        sa.Column('result', postgresql.JSONB()),
        sa.UniqueConstraint('workspace_id', 'agent_name', 'request_key'))
    op.create_index('ix_operation_approvals_workspace_session', 'operation_approvals', ['workspace_id', 'session_id'])


def downgrade():
    op.drop_table('operation_approvals')
