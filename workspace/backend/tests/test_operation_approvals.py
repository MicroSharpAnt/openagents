"""Single-operation permissions through the HTTP boundary."""
from tests.test_agent_owner_conversations import owned, SESSION, takeover
from tests.test_people_messaging import people, quiet_side_effects, _as, _tok

BASE = '/v1/operation-approvals'


def machine(ws):
    return {**_tok(ws), 'X-Agent-Name': 'agent-alpha'}


def create(client, ws, key='one', **operation):
    return client.post(BASE, headers=machine(ws), json={
        'network': ws['id'], 'session_id': SESSION, 'request_key': key,
        'operation': {'kind': 'move', 'root': '/work', 'source': 'a.txt',
                      'destination': 'b.txt', 'expected_state': 'a' * 64, **operation}})


def test_context_and_immutable_idempotent_request(client, owned):
    context = client.get(BASE + '/context', params={'network': owned['id'], 'session_id': SESSION}, headers=machine(owned))
    assert context.status_code == 200, context.text
    assert context.json()['data']['required'] is True
    first = create(client, owned)
    assert first.status_code == 200, first.text
    second = create(client, owned)
    assert second.json()['data']['id'] == first.json()['data']['id']
    assert create(client, owned, destination='c.txt').status_code == 409
    assert first.json()['data']['status'] == 'pending'


def test_only_actual_owner_decides_and_each_visitor_sees_their_own(client, owned):
    row = create(client, owned).json()['data']
    url = BASE + '/' + row['id']
    for who in ('adam', 'mia'):
        assert client.get(url, params={'network': owned['id']}, headers=_as(who, owned)).status_code == 200
    assert client.get(url, params={'network': owned['id']}, headers=_as('vic', owned)).status_code == 404
    assert client.get(BASE, params={'network': owned['id']}, headers=_as('vic', owned)).json()['data']['requests'] == []
    body = {'network': owned['id'], 'decision': 'approve'}
    for headers in (_as('mia', owned), _as('vic', owned), machine(owned), _tok(owned)):
        assert client.post(url + '/decision', json=body, headers=headers).status_code in (403, 404)
    assert client.post(url + '/decision', json=body, headers=_as('adam', owned)).json()['data']['status'] == 'approved'
    assert client.post(url + '/decision', json=body, headers=_as('adam', owned)).status_code == 409


def test_claim_waits_for_resume_and_only_executes_once_with_secret_completion(client, owned):
    row = create(client, owned).json()['data']
    url = BASE + '/' + row['id']
    body = {'network': owned['id'], 'operation_digest': row['operation_digest']}
    assert client.post(url + '/claim', json=body, headers=machine(owned)).status_code == 409
    client.post(url + '/decision', json={'network': owned['id'], 'decision': 'approve'}, headers=_as('adam', owned))
    takeover(client, owned, True)
    assert client.post(url + '/claim', json=body, headers=machine(owned)).status_code == 409
    takeover(client, owned, False)
    assert client.post(url + '/claim', json={**body, 'operation_digest': 'wrong'}, headers=machine(owned)).status_code == 409
    claim = client.post(url + '/claim', json=body, headers=machine(owned))
    assert claim.status_code == 200, claim.text
    token = claim.json()['data']['execution_token']
    assert len(token) >= 32
    assert client.post(url + '/claim', json=body, headers=machine(owned)).status_code == 409
    assert 'execution_token' not in client.get(url, params={'network': owned['id']}, headers=_as('mia', owned)).json()['data']
    result = {'network': owned['id'], 'execution_token': 'wrong', 'status': 'succeeded', 'result': {'moved': True}}
    assert client.post(url + '/result', json=result, headers=machine(owned)).status_code == 403
    result['execution_token'] = token
    for _ in range(2):
        assert client.post(url + '/result', json=result, headers=machine(owned)).json()['data']['status'] == 'succeeded'
    assert client.post(url + '/result', json={**result, 'status': 'failed'}, headers=machine(owned)).status_code == 409


def test_context_rejects_unknown_visitor_and_missing_agent_identity(client, owned):
    params = {'network': owned['id'], 'session_id': 'dm:human:stranger@example.test,openagents:agent-alpha'}
    assert client.get(BASE + '/context', params=params, headers=machine(owned)).status_code == 403
    params['session_id'] = SESSION
    assert client.get(BASE + '/context', params=params, headers=_tok(owned)).status_code == 403


def test_withdraw_expire_and_changed_owner_never_grant_execution(client, owned, db, monkeypatch):
    from datetime import timedelta
    from app.services import operation_approvals as svc
    from app.models import WorkspaceMember
    from tests.test_people_messaging import VIC
    rows = [create(client, owned, key=str(n)).json()['data'] for n in range(3)]
    for row in rows:
        client.post(BASE + '/' + row['id'] + '/decision', headers=_as('adam', owned),
                    json={'network': owned['id'], 'decision': 'approve'})
    url = BASE + '/' + rows[0]['id']
    assert client.post(url + '/decision', headers=_as('mia', owned), json={'network': owned['id'], 'decision': 'withdraw'}).json()['data']['status'] == 'withdrawn'
    now = svc.now()
    monkeypatch.setattr(svc, 'now', lambda: now + timedelta(minutes=31))
    expired = client.get(BASE + '/' + rows[1]['id'], headers=machine(owned), params={'network': owned['id']})
    assert expired.json()['data']['status'] == 'expired'
    monkeypatch.setattr(svc, 'now', lambda: now)
    member = db.get(WorkspaceMember, (owned['id'], 'agent-alpha'))
    member.owner_email = VIC
    db.commit()
    invalid = client.get(BASE + '/' + rows[2]['id'], headers=machine(owned), params={'network': owned['id']})
    assert invalid.json()['data']['status'] == 'invalidated'
    for row in rows:
        assert client.post(BASE + '/' + row['id'] + '/claim', headers=machine(owned), json={
            'network': owned['id'], 'operation_digest': row['operation_digest']}).status_code == 409
    assert client.get(BASE, headers=_as('adam', owned), params={'network': owned['id']}).json()['data']['requests'] == []


def test_path_scope_is_validated_and_payload_cannot_supply_owner(client, owned):
    for changes in ({'source': '../secret'}, {'source': '/secret'}, {'source': '.'},
                    {'destination': 'a.txt/sub'}, {'destination': 'a.txt'}, {'root': 'relative'},
                    {'kind': 'delete'}, {'owner_email': 'mia@acme.test'}, {'expected_state': 'unhashed'}):
        assert create(client, owned, **changes).status_code == 422


def test_denial_uses_standard_response_wrapper(client, owned):
    response = client.get(BASE + '/context', params={'network': owned['id'], 'session_id': SESSION}, headers=_tok(owned))
    assert response.status_code == 403
    assert response.json()['code'] == 403
    assert response.json()['data'] is None
