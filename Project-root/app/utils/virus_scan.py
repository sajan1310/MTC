"""
Optional virus scanning integration for production environments.

This module provides ClamAV integration for scanning uploaded files.
ClamAV must be installed and clamd daemon must be running.

Installation:
- Ubuntu/Debian: sudo apt-get install clamav clamav-daemon
- macOS: brew install clamav
- Windows: Download from https://www.clamav.net/

Configuration:
Set ENABLE_VIRUS_SCAN=true in environment to enable scanning.
"""
import os
import logging
from typing import Tuple

logger = logging.getLogger(__name__)

# Check if virus scanning is enabled
VIRUS_SCAN_ENABLED = os.getenv('ENABLE_VIRUS_SCAN', 'false').lower() == 'true'

# Try to import pyclamd if virus scanning is enabled
if VIRUS_SCAN_ENABLED:
    try:
        import pyclamd
        cd = pyclamd.ClamdUnixSocket()
        # Test connection
        if not cd.ping():
            logger.error("[VIRUS_SCAN] ClamAV daemon not responding. Virus scanning disabled.")
            VIRUS_SCAN_ENABLED = False
        else:
            logger.info("[VIRUS_SCAN] ClamAV connection established successfully.")
    except ImportError:
        logger.error("[VIRUS_SCAN] pyclamd not installed. Run: pip install pyclamd")
        VIRUS_SCAN_ENABLED = False
    except Exception as e:
        logger.error(f"[VIRUS_SCAN] Failed to connect to ClamAV: {e}")
        VIRUS_SCAN_ENABLED = False


def scan_file(file_path: str) -> Tuple[bool, str]:
    """
    Scan file for viruses using ClamAV.
    
    Args:
        file_path: Absolute path to file to scan
    
    Returns:
        (is_clean, message): True if clean, False if virus detected
    
    Raises:
        Exception: If scanning fails due to system error
    """
    if not VIRUS_SCAN_ENABLED:
        logger.debug("[VIRUS_SCAN] Scanning disabled, skipping check")
        return True, "Virus scanning disabled"
    
    if not os.path.exists(file_path):
        logger.error(f"[VIRUS_SCAN] File not found: {file_path}")
        raise FileNotFoundError(f"File not found: {file_path}")
    
    try:
        result = cd.scan_file(file_path)
        
        if result is None:
            # Clean file
            logger.info(f"[VIRUS_SCAN] Clean | file={os.path.basename(file_path)}")
            return True, "File is clean"
        
        # Virus detected
        virus_name = result[file_path][1] if file_path in result else "Unknown"
        logger.error(
            f"[VIRUS_DETECTED] ALERT | "
            f"file={os.path.basename(file_path)} | "
            f"virus={virus_name}"
        )
        
        # Delete infected file immediately
        try:
            os.remove(file_path)
            logger.info(f"[VIRUS_SCAN] Deleted infected file: {os.path.basename(file_path)}")
        except Exception as e:
            logger.error(f"[VIRUS_SCAN] Failed to delete infected file: {e}")
        
        return False, f"Virus detected: {virus_name}"
    
    except Exception as e:
        logger.error(f"[VIRUS_SCAN] Scan error | file={os.path.basename(file_path)} | error={str(e)}")
        raise Exception(f"Virus scan failed: {str(e)}")


def scan_buffer(file_buffer: bytes) -> Tuple[bool, str]:
    """
    Scan file buffer for viruses using ClamAV.
    
    Args:
        file_buffer: File content as bytes
    
    Returns:
        (is_clean, message): True if clean, False if virus detected
    """
    if not VIRUS_SCAN_ENABLED:
        return True, "Virus scanning disabled"
    
    try:
        result = cd.scan_stream(file_buffer)
        
        if result is None:
            logger.info("[VIRUS_SCAN] Buffer scan clean")
            return True, "Buffer is clean"
        
        virus_name = result.get('stream', ['FOUND', 'Unknown'])[1]
        logger.error(f"[VIRUS_DETECTED] ALERT in buffer | virus={virus_name}")
        
        return False, f"Virus detected in buffer: {virus_name}"
    
    except Exception as e:
        logger.error(f"[VIRUS_SCAN] Buffer scan error: {str(e)}")
        raise Exception(f"Virus scan failed: {str(e)}")


def get_scan_status() -> dict:
    """
    Get current virus scanning status and ClamAV version.
    
    Returns:
        dict with enabled status, version, and database info
    """
    if not VIRUS_SCAN_ENABLED:
        return {
            'enabled': False,
            'reason': 'Virus scanning not enabled or ClamAV not available'
        }
    
    try:
        version = cd.version()
        stats = cd.stats()
        return {
            'enabled': True,
            'version': version,
            'stats': stats
        }
    except Exception as e:
        return {
            'enabled': False,
            'error': str(e)
        }


# Integration with file upload validation
def validate_upload_with_virus_scan(file_storage, max_size_mb: int = 10, user_id: int = None) -> bool:
    """
    Extended validation that includes virus scanning.
    
    This wraps the standard validate_upload and adds virus scanning.
    Use this in production environments where virus scanning is critical.
    
    Args:
        file_storage: Werkzeug FileStorage object
        max_size_mb: Maximum file size in MB
        user_id: Optional user ID for audit logging
    
    Returns:
        True if validation and virus scan pass
    
    Raises:
        ValueError: If validation or virus scan fails
    """
    from .file_validation import validate_upload
    
    # First, run standard validation (size, MIME, magic number)
    validate_upload(file_storage, max_size_mb=max_size_mb, user_id=user_id)
    
    # Then scan for viruses if enabled
    if VIRUS_SCAN_ENABLED:
        # Read file content for scanning
        file_storage.stream.seek(0)
        file_content = file_storage.stream.read()
        file_storage.stream.seek(0)
        
        is_clean, message = scan_buffer(file_content)
        if not is_clean:
            logger.error(
                f"[UPLOAD_REJECTED] Virus detected | "
                f"user_id={user_id} | filename={file_storage.filename} | "
                f"virus={message}"
            )
            raise ValueError(f"File rejected: {message}")
        
        logger.info(
            f"[UPLOAD_VALIDATED] Virus scan passed | "
            f"user_id={user_id} | filename={file_storage.filename}"
        )
    
    return True
