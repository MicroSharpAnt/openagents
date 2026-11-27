"""Opt-in, operator-provisioned password login for local instances.

No registration or external identity provider. The operator supplies a scrypt
hash and a session secret; ordinary workspace authorization still applies.
"""
import hashlib
import json
import os
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.firebase_auth import mint_workspace_session, workspace_session_enabled
from app.response import ResponseCode, json_response, success_response

router = APIRouter(prefix="/v1/auth", tags=["Auth"])


class LocalSessionRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=1024)


def _local_accounts():
    """A configured accounts file replaces the legacy single-account settings."""
    path = os.environ.get("LOCAL_AUTH_USERS_FILE")
    if path:
        with open(path, encoding="utf-8") as source:
            rows = json.load(source)
    else:
        rows = [{
            "email": os.environ.get("LOCAL_AUTH_EMAIL", ""),
            "password_hash": os.environ.get("LOCAL_AUTH_PASSWORD_HASH", ""),
            "display_name": os.environ.get("LOCAL_AUTH_DISPLAY_NAME", "Local Developer"),
        }]
    if not isinstance(rows, list) or not rows:
        raise ValueError("Invalid accounts")
    accounts = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Invalid account")
        email, encoded = row.get("email"), row.get("password_hash")
        name = row.get("display_name", "Local User")
        if not isinstance(email, str) or not isinstance(encoded, str) or not isinstance(name, str):
            raise ValueError("Invalid account")
        email = email.strip().lower()
        if not email or email in accounts:
            raise ValueError("Missing or duplicate email")
        salt_hex, digest_hex = encoded.split(":")
        salt, expected = bytes.fromhex(salt_hex), bytes.fromhex(digest_hex)
        if len(salt) != 16 or len(expected) != 32:
            raise ValueError("Invalid hash")
        accounts[email] = (name, salt, expected)
    return accounts


@router.post("/local-session")
def local_session(body: LocalSessionRequest):
    if os.environ.get("LOCAL_AUTH_ENABLED") != "1":
        return json_response(ResponseCode.NOT_FOUND, "Local login is disabled")
    if not workspace_session_enabled():
        return json_response(ResponseCode.INTERNAL_ERROR, "Local login is not configured", status_code=503)
    try:
        accounts = _local_accounts()
        email = body.email.strip().lower()
        # Perform the same password work for unknown addresses.
        name, salt, expected = accounts.get(email, next(iter(accounts.values())))
        actual = hashlib.scrypt(body.password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
    except (OSError, ValueError, TypeError):
        return json_response(ResponseCode.INTERNAL_ERROR, "Local login is not configured", status_code=503)
    password_ok = secrets.compare_digest(actual, expected)
    if not password_ok or email not in accounts:
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid email or password")
    token, exp = mint_workspace_session({"email": email, "display_name": name, "email_verified": True})
    return success_response({
        "session_token": token,
        "expires_at": datetime.fromtimestamp(exp, tz=timezone.utc).isoformat(),
        "email": email,
        "display_name": name,
    })
