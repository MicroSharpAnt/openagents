"""Owner oversight is scoped to an agent's visitor conversation, never all DMs."""
import pytest
from app.models import WorkspaceMember
from tests.test_people_messaging import people, quiet_side_effects, _as, _tok, _dm, _conv, ADAM, MIA, VIC

AGENT = 'openagents:agent-alpha'
PAIR = f'human:{MIA},{AGENT}'
SESSION = 'dm:' + PAIR

@pytest.fixture
def owned(db, workspace, people):
    member = db.get(WorkspaceMember, (workspace['id'], 'agent-alpha'))
    member.owner_email = ADAM
    db.commit()
    return workspace


def conversations(client, ws, who):
    response = client.get('/v1/events/conversations', params={'network': ws['id']}, headers=_as(who, ws))
    assert response.status_code == 200, response.text
    return response.json()['data']['conversations']


def test_owner_reads_visitor_history_without_granting_other_visitors_access(client, owned):
    _dm(client, owned, by='mia', to=AGENT, content='visitor private question')
    assert _conv(client, owned, 'adam', f'human:{MIA}', AGENT) == ['visitor private question']
    assert _conv(client, owned, 'vic', f'human:{MIA}', AGENT) == []
    assert [c['agents'] for c in conversations(client, owned, 'adam')] == [[f'human:{MIA}', AGENT]]
    assert conversations(client, owned, 'vic') == []


def owner_message(client, ws, who='adam', **overrides):
    body = {'type': 'workspace.message.posted', 'network': ws['id'], 'visibility': 'direct',
            'source': 'human:user', 'target': f'human:{MIA}', 'payload': {'content': 'Owner here'},
            'metadata': {'dm_conversation': SESSION}}
    body.update(overrides)
    return client.post('/v1/events', json=body, headers=_as(who, ws))


def test_owner_participates_as_human_in_original_conversation(client, owned):
    _dm(client, owned, by='mia', to=AGENT, content='question')
    response = owner_message(client, owned)
    assert response.status_code == 200, response.text
    event = response.json()['data']
    assert event['source'] == f'human:{ADAM}'
    assert event['metadata']['dm_owner'] == ADAM
    assert event['metadata']['dm_conversation'] == SESSION
    for person in ('adam', 'mia'):
        assert _conv(client, owned, person, f'human:{MIA}', AGENT) == ['question', 'Owner here']
        rows = conversations(client, owned, person)
        assert len(rows) == 1
        assert rows[0]['message_count'] == 2
        assert rows[0]['last_message']['sender'] == f'human:{ADAM}'
    assert _conv(client, owned, 'vic', f'human:{MIA}', AGENT) == []
    assert owner_message(client, owned, 'vic').status_code == 403


def takeover(client, ws, paused, who='adam'):
    return client.patch('/v1/direct-conversations/takeover', headers=_as(who, ws),
                        json={'network': ws['id'], 'session_id': SESSION, 'paused': paused})


def visitor_message(client, ws, who='mia'):
    return client.post('/v1/events', headers=_as(who, ws), json={
        'type': 'workspace.message.posted', 'network': ws['id'], 'visibility': 'direct',
        'source': 'human:user', 'target': AGENT, 'payload': {'content': 'next question'},
        'metadata': {'target_agents': ['agent-alpha']}})


def test_takeover_is_per_conversation_and_only_owner_can_resume(client, owned):
    assert visitor_message(client, owned).json()['data']['metadata']['target_agents'] == ['agent-alpha']
    assert takeover(client, owned, True, 'mia').status_code == 403
    response = takeover(client, owned, True)
    assert response.status_code == 200, response.text
    assert response.json()['data']['paused'] is True
    assert visitor_message(client, owned).json()['data']['metadata']['target_agents'] == ['__no_response__']
    assert visitor_message(client, owned, 'vic').json()['data']['metadata']['target_agents'] == ['agent-alpha']
    reply = client.post('/v1/events', headers=_tok(owned), json={
        'type': 'workspace.message.posted', 'network': owned['id'], 'visibility': 'direct',
        'source': AGENT, 'target': f'human:{MIA}', 'payload': {'content': 'late reply'}})
    assert reply.status_code == 403
    assert owner_message(client, owned).status_code == 200
    state = client.get('/v1/direct-conversations/state', params={'network': owned['id'], 'session_id': SESSION}, headers=_as('mia', owned))
    assert state.json()['data']['paused'] is True
    assert state.json()['data']['can_manage'] is False
    assert takeover(client, owned, False).status_code == 200
    assert visitor_message(client, owned).json()['data']['metadata']['target_agents'] == ['agent-alpha']


def test_owner_and_visitor_can_quote_each_other_without_opening_a_new_dm(client, owned):
    question = _dm(client, owned, by='mia', to=AGENT, content='question to quote')
    reply = owner_message(client, owned, payload={'content': 'quoted answer', 'reply_to': question['id']})
    assert reply.status_code == 200, reply.text
    assert reply.json()['data']['metadata']['reply_to']['thread_id'] == SESSION
    answer = reply.json()['data']
    quoted = client.post('/v1/events', headers=_as('mia', owned), json={
        'type': 'workspace.message.posted', 'network': owned['id'], 'source': 'human:user',
        'target': AGENT, 'visibility': 'direct', 'payload': {'content': 'thanks', 'reply_to': answer['id']}})
    assert quoted.status_code == 200, quoted.text


def test_live_stream_and_incremental_history_stay_private(client, owned, monkeypatch):
    from app import cache
    from tests.test_stream_privacy import _stream
    published = []
    monkeypatch.setattr(cache, 'publish_event', lambda ch, data: published.append(data))
    question = _dm(client, owned, by='mia', to=AGENT, content='visitor one')
    _dm(client, owned, by='vic', to=AGENT, content='visitor two')
    reply = owner_message(client, owned).json()['data']
    assert {'visitor one', 'visitor two', 'Owner here'} <= set(_stream(client, owned, monkeypatch, published, headers=_as('adam', owned)))
    assert 'visitor two' not in _stream(client, owned, monkeypatch, published, headers=_as('mia', owned))
    assert 'Owner here' not in _stream(client, owned, monkeypatch, published, headers=_as('vic', owned))
    events = client.get('/v1/events', params={'network': owned['id'], 'conversation': PAIR, 'after': question['id']}, headers=_as('mia', owned)).json()['data']['events']
    assert [e['id'] for e in events] == [reply['id']]


def test_owner_cannot_be_spoofed_and_access_follows_current_ownership(client, owned, db):
    response = owner_message(client, owned, 'vic', metadata={'dm_owner': ADAM, 'dm_agent': AGENT})
    assert response.status_code == 200
    assert 'dm_owner' not in response.json()['data']['metadata']
    _dm(client, owned, by='mia', to=AGENT, content='agent private')
    assert takeover(client, owned, True).status_code == 200
    member = db.get(WorkspaceMember, (owned['id'], 'agent-alpha'))
    member.owner_email = VIC
    db.commit()
    assert _conv(client, owned, 'adam', f'human:{MIA}', AGENT) == []
    assert takeover(client, owned, False).status_code == 403
    assert _conv(client, owned, 'vic', f'human:{MIA}', AGENT) == ['agent private', None]  # takeover notice
    assert visitor_message(client, owned).json()['data']['metadata']['target_agents'] == ['agent-alpha']
