"""
Audit Service
Centralized audit logging for Universal Process Framework
Tracks all create, update, delete operations for compliance and debugging
"""

import json
from datetime import datetime
from flask import request
from flask_login import current_user
from database import get_conn


class AuditService:
    """Service for logging user actions and entity changes"""
    
    @staticmethod
    def log_action(action_type, entity_type, entity_id=None, entity_name=None, 
                   changes=None, metadata=None, user_id=None):
        """
        Log an audit event
        
        Args:
            action_type: CREATE, UPDATE, DELETE, EXECUTE, VIEW
            entity_type: Type of entity (process, subprocess, variant_usage, etc.)
            entity_id: ID of the affected entity (optional for batch operations)
            entity_name: Human-readable name/description of entity
            changes: Dict with 'old' and 'new' values or other change details
            metadata: Additional context (request info, batch size, etc.)
            user_id: Override user ID (defaults to current_user)
            
        Returns:
            int: audit_log.id or None if failed
        """
        conn = None
        try:
            conn = get_conn()
            cur = conn.cursor()
            
            # Determine user
            if user_id is None:
                if current_user and hasattr(current_user, 'id'):
                    user_id = current_user.id
                else:
                    # System action or unauthenticated - skip logging
                    return None
            
            # Build metadata if not provided
            if metadata is None:
                metadata = {}
            
            # Add request context if available
            if request:
                metadata['ip'] = request.remote_addr
                metadata['method'] = request.method
                metadata['endpoint'] = request.endpoint
                metadata['user_agent'] = request.headers.get('User-Agent', '')[:200]
            
            metadata['timestamp'] = datetime.utcnow().isoformat()
            
            # Insert audit log
            cur.execute("""
                INSERT INTO audit_log 
                (user_id, action_type, entity_type, entity_id, entity_name, changes, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id
            """, (
                user_id,
                action_type,
                entity_type,
                entity_id,
                entity_name,
                json.dumps(changes) if changes else None,
                json.dumps(metadata)
            ))
            
            audit_id = cur.fetchone()[0]
            conn.commit()
            
            return audit_id
            
        except Exception as e:
            if conn:
                conn.rollback()
            print(f"Audit logging failed: {e}")
            # Don't raise - audit failure should not break business logic
            return None
        finally:
            if conn:
                try:
                    cur.close()
                    conn.close()
                except:
                    pass
    
    @staticmethod
    def log_create(entity_type, entity_id, entity_name, data=None):
        """Shortcut for CREATE actions"""
        return AuditService.log_action(
            action_type='CREATE',
            entity_type=entity_type,
            entity_id=entity_id,
            entity_name=entity_name,
            changes={'new': data}
        )
    
    @staticmethod
    def log_update(entity_type, entity_id, entity_name, old_data=None, new_data=None):
        """Shortcut for UPDATE actions"""
        return AuditService.log_action(
            action_type='UPDATE',
            entity_type=entity_type,
            entity_id=entity_id,
            entity_name=entity_name,
            changes={'old': old_data, 'new': new_data}
        )
    
    @staticmethod
    def log_delete(entity_type, entity_id, entity_name, data=None):
        """Shortcut for DELETE actions"""
        return AuditService.log_action(
            action_type='DELETE',
            entity_type=entity_type,
            entity_id=entity_id,
            entity_name=entity_name,
            changes={'deleted': data}
        )
    
    @staticmethod
    def log_execute(entity_type, entity_id, entity_name, metadata=None):
        """Shortcut for EXECUTE actions (e.g., production lot execution)"""
        return AuditService.log_action(
            action_type='EXECUTE',
            entity_type=entity_type,
            entity_id=entity_id,
            entity_name=entity_name,
            metadata=metadata
        )
    
    @staticmethod
    def get_entity_history(entity_type, entity_id, limit=50):
        """
        Get audit history for a specific entity
        
        Args:
            entity_type: Type of entity
            entity_id: ID of entity
            limit: Max records to return
            
        Returns:
            list: Audit log entries
        """
        conn = None
        try:
            conn = get_conn()
            cur = conn.cursor()
            
            cur.execute("""
                SELECT 
                    al.id,
                    al.action_type,
                    al.entity_name,
                    al.changes,
                    al.metadata,
                    al.timestamp,
                    u.username,
                    u.email
                FROM audit_log al
                LEFT JOIN users u ON al.user_id = u.id
                WHERE al.entity_type = %s 
                  AND al.entity_id = %s
                  AND al.deleted_at IS NULL
                ORDER BY al.timestamp DESC
                LIMIT %s
            """, (entity_type, entity_id, limit))
            
            rows = cur.fetchall()
            
            history = []
            for row in rows:
                history.append({
                    'id': row[0],
                    'action_type': row[1],
                    'entity_name': row[2],
                    'changes': row[3],
                    'metadata': row[4],
                    'timestamp': row[5].isoformat() if row[5] else None,
                    'username': row[6],
                    'email': row[7]
                })
            
            return history
            
        except Exception as e:
            print(f"Error retrieving audit history: {e}")
            return []
        finally:
            if conn:
                try:
                    cur.close()
                    conn.close()
                except:
                    pass
    
    @staticmethod
    def get_user_activity(user_id, limit=100):
        """
        Get recent activity for a user
        
        Args:
            user_id: User ID
            limit: Max records to return
            
        Returns:
            list: Audit log entries
        """
        conn = None
        try:
            conn = get_conn()
            cur = conn.cursor()
            
            cur.execute("""
                SELECT 
                    id,
                    action_type,
                    entity_type,
                    entity_id,
                    entity_name,
                    timestamp
                FROM audit_log
                WHERE user_id = %s
                  AND deleted_at IS NULL
                ORDER BY timestamp DESC
                LIMIT %s
            """, (user_id, limit))
            
            rows = cur.fetchall()
            
            activity = []
            for row in rows:
                activity.append({
                    'id': row[0],
                    'action_type': row[1],
                    'entity_type': row[2],
                    'entity_id': row[3],
                    'entity_name': row[4],
                    'timestamp': row[5].isoformat() if row[5] else None
                })
            
            return activity
            
        except Exception as e:
            print(f"Error retrieving user activity: {e}")
            return []
        finally:
            if conn:
                try:
                    cur.close()
                    conn.close()
                except:
                    pass


# Convenience instance
audit = AuditService()
