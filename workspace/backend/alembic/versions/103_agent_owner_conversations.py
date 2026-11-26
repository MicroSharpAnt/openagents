"""Owner takeover and canonical grouping of owner replies in visitor DMs.

Revision ID: 103
Revises: 102
"""
import sqlalchemy as sa
from alembic import op

revision = '103'
down_revision = '102'
branch_labels = None
depends_on = None
deployment_backward_compatible = True


PREVIOUS_FUNCTION_SQL = """
CREATE OR REPLACE FUNCTION dm_pair_summary_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    pair_a text;
    pair_b text;
    old_ok boolean := false;
    new_ok boolean := false;
    newest bigint;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        old_ok := COALESCE(
    OLD.visibility = 'direct'
    AND OLD.type = 'workspace.message.posted'
    AND lower(OLD.source) <> 'human:system'
    AND lower(OLD.target) <> 'human:system'
    AND NOT (OLD.target LIKE 'channel/%'), false);
    END IF;
    IF TG_OP <> 'DELETE' THEN
        new_ok := COALESCE(
    NEW.visibility = 'direct'
    AND NEW.type = 'workspace.message.posted'
    AND lower(NEW.source) <> 'human:system'
    AND lower(NEW.target) <> 'human:system'
    AND NOT (NEW.target LIKE 'channel/%'), false);
    END IF;
    IF TG_OP = 'UPDATE' AND old_ok AND new_ok
       AND OLD.network_id = NEW.network_id AND OLD.source = NEW.source
       AND OLD.target = NEW.target AND OLD.timestamp = NEW.timestamp THEN
        RETURN NULL;  -- same pair, same time: nothing to change
    END IF;

    IF old_ok THEN
        pair_a := LEAST(OLD.source, OLD.target);
        pair_b := GREATEST(OLD.source, OLD.target);
        -- Upsert so a delta is never lost before the workspace is backfilled.
        INSERT INTO dm_pair_summaries AS s (workspace_id, agent_a, agent_b, msg_count, last_ts)
        VALUES (OLD.network_id, pair_a, pair_b, -1, 0)
        ON CONFLICT (workspace_id, agent_a, agent_b)
        DO UPDATE SET msg_count = s.msg_count - 1
        RETURNING s.last_ts INTO newest;
        IF OLD.timestamp >= newest THEN
            SELECT max(e.timestamp) INTO newest FROM events e
             WHERE e.network_id = OLD.network_id
               AND COALESCE(
    e.visibility = 'direct'
    AND e.type = 'workspace.message.posted'
    AND lower(e.source) <> 'human:system'
    AND lower(e.target) <> 'human:system'
    AND NOT (e.target LIKE 'channel/%'), false)
               AND ((e.source = pair_a AND e.target = pair_b)
                 OR (e.source = pair_b AND e.target = pair_a));
            UPDATE dm_pair_summaries SET last_ts = COALESCE(newest, 0)
             WHERE workspace_id = OLD.network_id AND agent_a = pair_a AND agent_b = pair_b;
        END IF;
    END IF;

    IF new_ok THEN
        INSERT INTO dm_pair_summaries AS s (workspace_id, agent_a, agent_b, msg_count, last_ts)
        VALUES (NEW.network_id, LEAST(NEW.source, NEW.target), GREATEST(NEW.source, NEW.target), 1, NEW.timestamp)
        ON CONFLICT (workspace_id, agent_a, agent_b)
        DO UPDATE SET msg_count = s.msg_count + 1, last_ts = GREATEST(s.last_ts, EXCLUDED.last_ts);
    END IF;
    RETURN NULL;
END
$$;
"""


def _summary_sql():
    sql = PREVIOUS_FUNCTION_SQL
    for row in ('OLD', 'NEW', 'e'):
        sql = sql.replace(f'{row}.source', f"COALESCE({row}.metadata->>'dm_agent', {row}.source)")
    return sql


def upgrade():
    op.add_column('direct_thread_links', sa.Column('takeover_owner', sa.Text(), nullable=True))
    if op.get_bind().dialect.name == 'postgresql':
        op.execute("SET LOCAL lock_timeout = '5s'")
        op.execute(_summary_sql())
        op.execute('DROP TRIGGER IF EXISTS events_dm_pair_summary ON events')
        op.execute('''CREATE TRIGGER events_dm_pair_summary
            AFTER INSERT OR DELETE OR UPDATE OF network_id, source, target, type, visibility, timestamp, metadata ON events
            FOR EACH ROW EXECUTE FUNCTION dm_pair_summary_apply()''')


def downgrade():
    if op.get_bind().dialect.name == 'postgresql':
        op.execute("SET LOCAL lock_timeout = '5s'")
        op.execute(PREVIOUS_FUNCTION_SQL)
        op.execute('DROP TRIGGER IF EXISTS events_dm_pair_summary ON events')
        op.execute('''CREATE TRIGGER events_dm_pair_summary AFTER INSERT OR DELETE OR UPDATE OF network_id, source, target, type, visibility, timestamp ON events FOR EACH ROW EXECUTE FUNCTION dm_pair_summary_apply()''')
    op.drop_column('direct_thread_links', 'takeover_owner')
