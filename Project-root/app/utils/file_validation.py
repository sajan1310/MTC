import os
import magic
import logging
from datetime import datetime
from werkzeug.datastructures import FileStorage

ALLOWED_MIME_SIGNATURES = {
    'image/jpeg': [b'\xff\xd8\xff'],
    'image/png': [b'\x89PNG'],
    'image/gif': [b'GIF87a', b'GIF89a'],
    'application/pdf': [b'%PDF-'],
    'text/csv': [],  # Special handling
}

ALLOWED_MIMES = set(ALLOWED_MIME_SIGNATURES.keys())

logger = logging.getLogger(__name__)

def validate_upload(file_storage: FileStorage, max_size_mb: int = 10, user_id: int = None) -> bool:
    """
    Validate uploaded file for size, MIME type, and magic number signature.
    Raises ValueError on validation failure.
    Returns True if valid.
    
    Args:
        file_storage: Werkzeug FileStorage object
        max_size_mb: Maximum file size in MB (default 10)
        user_id: Optional user ID for audit logging
    
    Returns:
        True if validation passes
    
    Raises:
        ValueError: If validation fails
    """
    filename = file_storage.filename or 'unknown'
    from datetime import timezone
    timestamp = datetime.now(timezone.utc).isoformat()
    
    # Validate file size
    file_storage.stream.seek(0, os.SEEK_END)
    size = file_storage.stream.tell()
    file_storage.stream.seek(0)
    
    if size > max_size_mb * 1024 * 1024:
        logger.error(
            f"[UPLOAD_REJECTED] Size exceeded | "
            f"user_id={user_id} | filename={filename} | "
            f"size={size} | max={max_size_mb}MB | timestamp={timestamp}"
        )
        raise ValueError(f"File exceeds maximum allowed size of {max_size_mb}MB")

    # Read header for magic number
    header = file_storage.stream.read(2048)
    file_storage.stream.seek(0)
    mime = magic.from_buffer(header, mime=True)
    
    if mime not in ALLOWED_MIMES:
        logger.error(
            f"[UPLOAD_REJECTED] Forbidden MIME | "
            f"user_id={user_id} | filename={filename} | "
            f"mime={mime} | size={size} | timestamp={timestamp}"
        )
        raise ValueError(f"File type {mime} not allowed")

    # Magic number validation (except for text/csv)
    if mime != 'text/csv':
        valid = any(header.startswith(sig) for sig in ALLOWED_MIME_SIGNATURES[mime])
        if not valid:
            logger.error(
                f"[UPLOAD_REJECTED] Signature mismatch | "
                f"user_id={user_id} | filename={filename} | "
                f"mime={mime} | size={size} | timestamp={timestamp}"
            )
            raise ValueError('File signature does not match MIME type')
    else:
        # For CSV, check if decodable as text and has commas
        try:
            text = header.decode('utf-8', errors='ignore')
            if ',' not in text:
                logger.error(
                    f"[UPLOAD_REJECTED] Invalid CSV | "
                    f"user_id={user_id} | filename={filename} | "
                    f"size={size} | timestamp={timestamp}"
                )
                raise ValueError('CSV file does not appear valid')
        except Exception as e:
            logger.error(
                f"[UPLOAD_REJECTED] CSV decode error | "
                f"user_id={user_id} | filename={filename} | "
                f"error={str(e)} | timestamp={timestamp}"
            )
            raise ValueError('CSV file decode error')

    # Log successful upload validation
    logger.info(
        f"[UPLOAD_VALIDATED] Success | "
        f"user_id={user_id} | filename={filename} | "
        f"mime={mime} | size={size} | timestamp={timestamp}"
    )
    return True
