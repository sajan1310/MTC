import logging
import os
from datetime import datetime

# Optional import of the 'magic' library for MIME detection.
# If unavailable (e.g., in environments without python-magic-bin), fall back to Python's built-in mimetypes.
try:
    import magic
except ImportError:  # pragma: no cover
    magic = None
    import mimetypes

from werkzeug.datastructures import FileStorage

ALLOWED_MIME_SIGNATURES = {
    "image/jpeg": [b"\xff\xd8\xff"],
    "image/png": [b"\x89PNG"],
    "image/gif": [b"GIF87a", b"GIF89a"],
    "application/pdf": [b"%PDF-"],
    "text/csv": [],  # Special handling
}

ALLOWED_MIMES = set(ALLOWED_MIME_SIGNATURES.keys())

logger = logging.getLogger(__name__)


def validate_upload(
    file_storage: FileStorage, max_size_mb: int = 10, user_id: int = None
) -> bool:
    """Validate uploaded file for size, MIME type, and magic number signature.

    Raises:
        ValueError: If validation fails.
    Returns:
        True if the upload passes all checks.
    """
    filename = file_storage.filename or "unknown"
    from datetime import timezone
    timestamp = datetime.now(timezone.utc).isoformat()

    # --------------------
    # Size validation
    # --------------------
    file_storage.stream.seek(0, os.SEEK_END)
    size = file_storage.stream.tell()
    file_storage.stream.seek(0)
    if size > max_size_mb * 1024 * 1024:
        logger.error(
            f"[UPLOAD_REJECTED] Size exceeded | user_id={user_id} | filename={filename} | "
            f"size={size} | max={max_size_mb}MB | timestamp={timestamp}"
        )
        raise ValueError(f"File exceeds maximum allowed size of {max_size_mb}MB")

    # --------------------
    # MIME detection (magic or fallback)
    # --------------------
    header = file_storage.stream.read(2048)
    file_storage.stream.seek(0)
    if magic is not None:
        mime = magic.from_buffer(header, mime=True)
    else:
        # mimetypes may return None; default to generic binary type
        mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"

    if mime not in ALLOWED_MIMES:
        logger.error(
            f"[UPLOAD_REJECTED] Forbidden MIME | user_id={user_id} | filename={filename} | "
            f"mime={mime} | size={size} | timestamp={timestamp}"
        )
        raise ValueError(f"File type {mime} not allowed")

    # --------------------
    # Signature validation (except CSV)
    # --------------------
    if mime != "text/csv":
        # Some MIME types may have an empty signature list (e.g., CSV); treat as valid
        signatures = ALLOWED_MIME_SIGNATURES.get(mime, [])
        if signatures and not any(header.startswith(sig) for sig in signatures):
            logger.error(
                f"[UPLOAD_REJECTED] Signature mismatch | user_id={user_id} | filename={filename} | "
                f"mime={mime} | size={size} | timestamp={timestamp}"
            )
            raise ValueError("File signature does not match MIME type")
    else:
        # CSV specific validation – ensure it's decodable text and contains commas
        try:
            text = header.decode("utf-8", errors="ignore")
            if "," not in text:
                logger.error(
                    f"[UPLOAD_REJECTED] Invalid CSV | user_id={user_id} | filename={filename} | "
                    f"size={size} | timestamp={timestamp}"
                )
                raise ValueError("CSV file does not appear valid")
        except Exception as e:
            logger.error(
                f"[UPLOAD_REJECTED] CSV decode error | user_id={user_id} | filename={filename} | "
                f"error={str(e)} | timestamp={timestamp}"
            )
            raise ValueError("CSV file decode error")

    # --------------------
    # Successful validation logging
    # --------------------
    logger.info(
        f"[UPLOAD_VALIDATED] Success | user_id={user_id} | filename={filename} | "
        f"mime={mime} | size={size} | timestamp={timestamp}"
    )
    return True
