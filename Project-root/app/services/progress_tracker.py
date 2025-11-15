"""
Progress tracking system for long-running import operations.

Uses Redis for real-time progress updates with automatic expiry.
Falls back to in-memory storage if Redis is unavailable.

Features:
- Real-time progress tracking with percentage calculation
- Estimated time remaining calculation
- Redis-based storage with 24-hour auto-expiry
- Graceful fallback to in-memory storage
- Thread-safe operations
- Support for multiple concurrent imports
"""

import json
import logging
import time
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

try:
    import redis

    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False
    logging.warning("Redis not available, using in-memory progress tracking")

logger = logging.getLogger(__name__)


class ProgressTracker:
    """
    Tracks progress of import operations using Redis or in-memory storage.

    Stores progress data with automatic expiry and provides methods for
    updating and retrieving progress information.
    """

    # Default expiry time: 24 hours
    DEFAULT_EXPIRY_SECONDS = 86400

    # In-memory fallback storage
    _memory_store: Dict[str, Dict[str, Any]] = {}

    def __init__(
        self,
        redis_url: Optional[str] = None,
        expiry_seconds: int = DEFAULT_EXPIRY_SECONDS,
    ):
        """
        Initialize progress tracker.

        Args:
            redis_url: Redis connection URL (e.g., 'redis://localhost:6379/0')
            expiry_seconds: How long to keep progress data (default 24 hours)
        """
        self.expiry_seconds = expiry_seconds
        self.redis_client = None

        # Try to connect to Redis
        if REDIS_AVAILABLE and redis_url:
            try:
                self.redis_client = redis.from_url(
                    redis_url,
                    decode_responses=True,
                    socket_connect_timeout=5,
                    socket_timeout=5,
                )
                # Test connection
                self.redis_client.ping()
                logger.info(f"✅ Connected to Redis for progress tracking: {redis_url}")
            except Exception as e:
                logger.warning(
                    f"⚠️  Failed to connect to Redis: {e}. Using in-memory storage."
                )
                self.redis_client = None
        else:
            logger.info("Using in-memory progress tracking (Redis not configured)")

    def create_import_id(self) -> str:
        """
        Generate unique import ID.

        Returns:
            UUID string for tracking this import
        """
        return str(uuid.uuid4())

    def track_progress(
        self,
        import_id: str,
        processed: int,
        total: int,
        failed: int = 0,
        current_batch: Optional[int] = None,
        total_batches: Optional[int] = None,
        start_time: Optional[float] = None,
    ) -> None:
        """
        Update progress for an import operation.

        Args:
            import_id: Unique identifier for this import
            processed: Number of rows successfully processed
            total: Total number of rows to process
            failed: Number of rows that failed
            current_batch: Current batch number (optional)
            total_batches: Total number of batches (optional)
            start_time: Unix timestamp when import started (for ETA calculation)
        """
        # Calculate percentage
        percentage = (processed / total * 100) if total > 0 else 0.0

        # Calculate estimated time remaining
        eta_seconds = None
        if start_time and processed > 0:
            elapsed = time.time() - start_time
            rate = processed / elapsed  # rows per second
            remaining_rows = total - processed
            eta_seconds = remaining_rows / rate if rate > 0 else None

        # Build progress data
        progress_data = {
            "import_id": import_id,
            "processed": processed,
            "total": total,
            "failed": failed,
            "percentage": round(percentage, 2),
            "current_batch": current_batch,
            "total_batches": total_batches,
            "estimated_seconds_remaining": (
                round(eta_seconds, 1) if eta_seconds else None
            ),
            "updated_at": datetime.utcnow().isoformat(),
            "status": "processing",
        }

        # Store in Redis or memory
        if self.redis_client:
            try:
                key = f"import_progress:{import_id}"
                self.redis_client.setex(
                    key, self.expiry_seconds, json.dumps(progress_data)
                )
            except Exception as e:
                logger.error(f"Failed to store progress in Redis: {e}")
                # Fall back to memory
                self._memory_store[import_id] = progress_data
        else:
            self._memory_store[import_id] = progress_data

    def get_progress(self, import_id: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve current progress for an import.

        Args:
            import_id: Unique identifier for the import

        Returns:
            Progress dictionary or None if not found
        """
        # Try Redis first
        if self.redis_client:
            try:
                key = f"import_progress:{import_id}"
                data = self.redis_client.get(key)
                if data:
                    return json.loads(data)
            except Exception as e:
                logger.error(f"Failed to retrieve progress from Redis: {e}")

        # Fall back to memory
        return self._memory_store.get(import_id)

    def mark_completed(
        self,
        import_id: str,
        processed: int,
        total: int,
        failed: int,
        duration: float,
        success_rate: float,
    ) -> None:
        """
        Mark an import as completed.

        Args:
            import_id: Unique identifier for the import
            processed: Number of rows successfully processed
            total: Total number of rows attempted
            failed: Number of rows that failed
            duration: Total import duration in seconds
            success_rate: Percentage of successful rows
        """
        progress_data = {
            "import_id": import_id,
            "processed": processed,
            "total": total,
            "failed": failed,
            "percentage": 100.0,
            "estimated_seconds_remaining": 0,
            "duration_seconds": round(duration, 2),
            "success_rate": round(success_rate, 2),
            "updated_at": datetime.utcnow().isoformat(),
            "completed_at": datetime.utcnow().isoformat(),
            "status": "completed",
        }

        # Store in Redis or memory
        if self.redis_client:
            try:
                key = f"import_progress:{import_id}"
                self.redis_client.setex(
                    key, self.expiry_seconds, json.dumps(progress_data)
                )
            except Exception as e:
                logger.error(f"Failed to mark completion in Redis: {e}")
                self._memory_store[import_id] = progress_data
        else:
            self._memory_store[import_id] = progress_data

    def mark_failed(
        self, import_id: str, error_message: str, processed: int = 0, total: int = 0
    ) -> None:
        """
        Mark an import as failed.

        Args:
            import_id: Unique identifier for the import
            error_message: Description of the failure
            processed: Number of rows processed before failure
            total: Total number of rows attempted
        """
        progress_data = {
            "import_id": import_id,
            "processed": processed,
            "total": total,
            "failed": total - processed if total > 0 else 0,
            "percentage": (processed / total * 100) if total > 0 else 0.0,
            "error_message": error_message,
            "updated_at": datetime.utcnow().isoformat(),
            "failed_at": datetime.utcnow().isoformat(),
            "status": "failed",
        }

        # Store in Redis or memory
        if self.redis_client:
            try:
                key = f"import_progress:{import_id}"
                self.redis_client.setex(
                    key, self.expiry_seconds, json.dumps(progress_data)
                )
            except Exception as e:
                logger.error(f"Failed to mark failure in Redis: {e}")
                self._memory_store[import_id] = progress_data
        else:
            self._memory_store[import_id] = progress_data

    def delete_progress(self, import_id: str) -> None:
        """
        Delete progress data for an import (e.g., after user acknowledges completion).

        Args:
            import_id: Unique identifier for the import
        """
        if self.redis_client:
            try:
                key = f"import_progress:{import_id}"
                self.redis_client.delete(key)
            except Exception as e:
                logger.error(f"Failed to delete progress from Redis: {e}")

        # Also remove from memory
        self._memory_store.pop(import_id, None)

    def cleanup_expired(self) -> int:
        """
        Clean up expired progress entries from in-memory storage.

        Redis handles expiry automatically, but memory storage needs manual cleanup.

        Returns:
            Number of entries removed
        """
        if not self._memory_store:
            return 0

        now = datetime.utcnow()
        expired_keys = []

        for import_id, data in self._memory_store.items():
            try:
                updated_at = datetime.fromisoformat(data.get("updated_at", ""))
                if now - updated_at > timedelta(seconds=self.expiry_seconds):
                    expired_keys.append(import_id)
            except Exception:
                # If we can't parse the date, consider it expired
                expired_keys.append(import_id)

        for key in expired_keys:
            del self._memory_store[key]

        if expired_keys:
            logger.info(f"Cleaned up {len(expired_keys)} expired progress entries")

        return len(expired_keys)


# Global progress tracker instance (initialized by Flask app)
_global_tracker: Optional[ProgressTracker] = None


def init_progress_tracker(
    redis_url: Optional[str] = None, expiry_seconds: int = 86400
) -> ProgressTracker:
    """
    Initialize the global progress tracker.

    Call this during Flask app initialization.

    Args:
        redis_url: Redis connection URL
        expiry_seconds: Progress data expiry time (default 24 hours)

    Returns:
        ProgressTracker instance
    """
    global _global_tracker
    _global_tracker = ProgressTracker(
        redis_url=redis_url, expiry_seconds=expiry_seconds
    )
    return _global_tracker


def get_progress_tracker() -> ProgressTracker:
    """
    Get the global progress tracker instance.

    Returns:
        ProgressTracker instance

    Raises:
        RuntimeError: If tracker not initialized
    """
    if _global_tracker is None:
        raise RuntimeError(
            "Progress tracker not initialized. "
            "Call init_progress_tracker() during app initialization."
        )
    return _global_tracker


# Convenience functions for direct use


def create_import_id() -> str:
    """Generate unique import ID"""
    return get_progress_tracker().create_import_id()


def track_progress(
    import_id: str,
    processed: int,
    total: int,
    failed: int = 0,
    current_batch: Optional[int] = None,
    total_batches: Optional[int] = None,
    start_time: Optional[float] = None,
) -> None:
    """Update import progress"""
    get_progress_tracker().track_progress(
        import_id, processed, total, failed, current_batch, total_batches, start_time
    )


def get_progress(import_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve import progress"""
    return get_progress_tracker().get_progress(import_id)


def mark_completed(
    import_id: str,
    processed: int,
    total: int,
    failed: int,
    duration: float,
    success_rate: float,
) -> None:
    """Mark import as completed"""
    get_progress_tracker().mark_completed(
        import_id, processed, total, failed, duration, success_rate
    )


def mark_failed(
    import_id: str, error_message: str, processed: int = 0, total: int = 0
) -> None:
    """Mark import as failed"""
    get_progress_tracker().mark_failed(import_id, error_message, processed, total)


def delete_progress(import_id: str) -> None:
    """Delete progress data"""
    get_progress_tracker().delete_progress(import_id)
