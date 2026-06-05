# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development

```bash
# Start PostgreSQL
docker compose up -d

# Install dependencies (first time)
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt

# Run the backend (serves frontend too)
cd backend
uvicorn main:app --reload --port 8000
```

The app is then available at `http://localhost:8000`. The frontend is served as static files by FastAPI itself — there is no separate frontend dev server.

**Environment variable:** `DATABASE_URL` defaults to `postgresql://poc:poc@localhost:5432/authenticity_poc` (matches docker-compose).

## Architecture

This is a **content authenticity proof-of-concept** with a FastAPI backend and vanilla HTML/JS frontend. There is no build step and no test suite.

### Request flow

1. **Register** (`POST /api/register`) — generates an Ed25519 keypair via `gnupg`, stores both keys and the PGP fingerprint in the `creators` table.
2. **Login** (`POST /api/login`) — user uploads their private key `.asc`; server extracts the fingerprint and looks up the matching creator.
3. **Register content** (`POST /api/register-content`) — fingerprints the file (pHash for images, SHA-256 of normalized text for PDFs), builds a JSON assertion, signs it with the creator's private key using OpenPGP clearsign, stores the result in `content_registrations`.
4. **Verify** (`POST /api/verify`) — re-fingerprints the file, finds the best match (exact for PDF, lowest Hamming distance for images), and verifies the stored OpenPGP signature.

### Module responsibilities

| File | Responsibility |
|------|---------------|
| `backend/main.py` | FastAPI app, all route handlers, serves frontend static files |
| `backend/fingerprint.py` | `phash_image` (pHash via imagehash), `sha256_pdf` (PyMuPDF text extraction + SHA-256), Hamming distance helpers |
| `backend/crypto.py` | GPG keypair generation, signing, verification — each call creates an isolated temp gnupghome and cleans it up |
| `backend/models.py` | SQLAlchemy ORM: `Creator` and `ContentRegistration` tables |
| `backend/database.py` | Engine + session factory |
| `frontend/index.html` | Public verifier UI |
| `frontend/creator.html` | Creator dashboard (register identity, upload content) |

### Image matching thresholds (fingerprint.py)

- Hamming distance = 0 → `authentic`
- 1–20 → `possibly_modified`
- > 20 → `not_found`

### Key design notes

- The server retains the private key (noted as a POC simplification in `models.py` — production would move signing client-side).
- `crypto.py` never touches `~/.gnupg`; every GPG operation runs in a fresh temp directory that is always cleaned up.
- Database tables are auto-created on startup via `Base.metadata.create_all`.

## Deployment

Push to `main` triggers a GitHub Actions workflow that SSHs into `77.90.40.64` and restarts the `signing-poc-backend` systemd service. The server uses its own `.venv` at `/home/anish/.venv/signing-poc/`.
