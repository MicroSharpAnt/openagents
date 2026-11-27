import hashlib
import json

import pytest

from app.config import config


def configure(monkeypatch):
    monkeypatch.delenv("LOCAL_AUTH_USERS_FILE", raising=False)
    salt = b'1234567890123456'
    digest = hashlib.scrypt(b'test-local-password', salt=salt, n=16384, r=8, p=1, dklen=32)
    monkeypatch.setenv('LOCAL_AUTH_ENABLED', '1')
    monkeypatch.setenv('LOCAL_AUTH_EMAIL', 'developer@example.test')
    monkeypatch.setenv('LOCAL_AUTH_PASSWORD_HASH', salt.hex()+':'+digest.hex())
    monkeypatch.setattr(config, 'WORKSPACE_SESSION_SECRET', 'test-session-secret-not-for-production-123456')


def test_local_login_disabled_by_default(client, monkeypatch):
    monkeypatch.delenv('LOCAL_AUTH_ENABLED', raising=False)
    assert client.post('/v1/auth/local-session', json={'email':'a@example.test','password':'x'}).status_code == 404


def test_local_identity_claim_and_pair(client, monkeypatch):
    configure(monkeypatch)
    credentials = {'email':'developer@example.test','password':'test-local-password'}
    assert client.post('/v1/auth/local-session', json={**credentials,'password':'wrong'}).status_code == 401
    assert client.post('/v1/auth/local-session', json={**credentials,'email':'other@example.test'}).status_code == 401
    login = client.post('/v1/auth/local-session', json=credentials)
    assert login.status_code == 200
    headers = {'Authorization': 'Bearer '+login.json()['data']['session_token']}
    workspace = client.post('/v1/workspaces', json={'name':'Local login test'}).json()['data']
    path = '/v1/workspaces/'+workspace['slug']
    assert client.post(path+'/claim', headers=headers).status_code == 403
    assert client.post(path+'/claim', headers={**headers,'X-Workspace-Token':workspace['token']}).status_code == 200
    memberships = client.get('/v1/account/workspaces', headers=headers).json()['data']
    assert any(w['slug']==workspace['slug'] and w['role']=='owner' for w in memberships)
    assert client.post(path+'/pairing-codes', headers=headers).status_code == 200
    assert client.post('/v1/auth/session/renew', headers=headers).status_code == 200


def test_local_login_fails_closed_with_invalid_config(client, monkeypatch):
    configure(monkeypatch)
    monkeypatch.setenv('LOCAL_AUTH_PASSWORD_HASH','invalid')
    assert client.post('/v1/auth/local-session', json={'email':'developer@example.test','password':'x'}).status_code == 503


def configure_accounts(monkeypatch, tmp_path):
    configure(monkeypatch)
    def account(email, password):
        salt = email.encode()[:16].ljust(16, b"0")
        digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
        return {"email": email, "password_hash": salt.hex()+":"+digest.hex(), "display_name": email.split("@")[0]}
    rows = [account("owner@example.test", "owner-password"), account("tester@example.test", "tester-password")]
    path = tmp_path / "accounts.json"
    path.write_text(json.dumps(rows))
    monkeypatch.setenv("LOCAL_AUTH_USERS_FILE", str(path))
    return path, rows


def test_multi_user_login_and_membership(client, monkeypatch, tmp_path):
    configure_accounts(monkeypatch, tmp_path)
    def login(email, password):
        return client.post("/v1/auth/local-session", json={"email": email, "password": password})
    owner = login(" OWNER@EXAMPLE.TEST ", "owner-password")
    tester = login("tester@example.test", "tester-password")
    assert owner.status_code == tester.status_code == 200
    assert owner.json()["data"]["email"] == "owner@example.test"
    assert tester.json()["data"]["display_name"] == "tester"
    assert owner.json()["data"]["session_token"] != tester.json()["data"]["session_token"]
    assert login("tester@example.test", "owner-password").status_code == 401
    assert login("unknown@example.test", "owner-password").status_code == 401
    assert login("developer@example.test", "test-local-password").status_code == 401
    owner_headers = {"Authorization": "Bearer " + owner.json()["data"]["session_token"]}
    tester_headers = {"Authorization": "Bearer " + tester.json()["data"]["session_token"]}
    workspace = client.post("/v1/workspaces", json={"name": "Multi-user test"}).json()["data"]
    path = "/v1/workspaces/" + workspace["slug"]
    assert client.post(path + "/claim", headers={**owner_headers, "X-Workspace-Token": workspace["token"]}).status_code == 200
    invite = client.post(path + "/invites", headers=owner_headers, json={"email": "tester@example.test", "role": "member"})
    assert invite.status_code == 200
    token = invite.json()["data"]["url"].rsplit("/", 1)[1]
    assert client.post("/v1/invites/" + token + "/accept", headers=owner_headers).status_code == 403
    accepted = client.post("/v1/invites/" + token + "/accept", headers=tester_headers)
    assert accepted.status_code == 200
    assert accepted.json()["data"]["role"] == "member"
    memberships = client.get("/v1/account/workspaces", headers=tester_headers).json()["data"]
    assert any(w["slug"] == workspace["slug"] and w["role"] == "member" for w in memberships)
    assert client.post(path + "/invites", headers=tester_headers, json={"role": "admin"}).status_code == 403


@pytest.mark.parametrize("invalid", ["missing", "json", "empty", "duplicate", "hash", "type"])
def test_accounts_file_fails_closed(client, monkeypatch, tmp_path, invalid):
    path, rows = configure_accounts(monkeypatch, tmp_path)
    if invalid == "missing":
        path.unlink()
    elif invalid == "json":
        path.write_text("{")
    else:
        if invalid == "empty":
            rows = []
        elif invalid == "duplicate":
            rows.append({**rows[0], "email": " OWNER@EXAMPLE.TEST "})
        elif invalid == "hash":
            rows[1]["password_hash"] = "invalid"
        else:
            rows[1]["email"] = 42
        path.write_text(json.dumps(rows))
    result = client.post("/v1/auth/local-session", json={"email": "developer@example.test", "password": "test-local-password"})
    assert result.status_code == 503
