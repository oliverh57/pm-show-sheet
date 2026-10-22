"""Google sign-in (installed-app OAuth, loopback redirect) and API clients."""
from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).parent
CREDENTIALS = HERE / "credentials.json"
TOKEN = HERE / ".state" / "token.json"

# drive.file only: the app can touch files it created, nothing else in the user's Drive.
# Part of the prototype is proving this narrow scope is enough for Sheets, Slides, comments and sharing.
SCOPES = ["https://www.googleapis.com/auth/drive.file"]


def _creds():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    creds = Credentials.from_authorized_user_file(str(TOKEN), SCOPES) if TOKEN.exists() else None
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not CREDENTIALS.exists():
                raise SystemExit(f"Missing {CREDENTIALS.name}. See README → 'Google Cloud setup'.")
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS), SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN.parent.mkdir(exist_ok=True)
        TOKEN.write_text(creds.to_json())
    return creds


def services():
    from googleapiclient.discovery import build

    creds = _creds()
    sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)
    return sheets, drive


def slides_service():
    from googleapiclient.discovery import build

    return build("slides", "v1", credentials=_creds(), cache_discovery=False)
