"""
Process Service for Universal Process Framework.

Handles all CRUD operations for processes and subprocesses including:
- Process creation, retrieval, update, deletion
- Subprocess management
- Process-subprocess associations
- Variant usage management
- Soft delete support
- Version tracking
"""
from __future__ import annotations
from datetime import datetime
from typing import Dict, List, Optional, Tuple, Any
import psycopg2.extras
from flask import current_app

import database
from ..models.process import Process, Subprocess, ProcessSubprocess


class ProcessService:
    """
    Service for process management operations.
    """
    
    @staticmethod
    def create_process(
        name: str,
        user_id: int,
        description: Optional[str] = None,
        process_class: str = 'assembly'
    ) -> Dict[str, Any]:
        """
        Create a new process.
        
        Args:
            name: Process name
            user_id: ID of user creating the process
            description: Optional process description
            process_class: Type of process (assembly, manufacturing, etc.)
        
        Returns:
            Created process as dict
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (conn, cur):
            cur.execute("""
                INSERT INTO processes (name, description, class, user_id, status, version)
                VALUES (%s, %s, %s, %s, 'draft', 1)
                RETURNING *
            """, (name, description, process_class, user_id))
            
            process_data = cur.fetchone()
            conn.commit()
        
        process = Process(process_data)
        return process.to_dict()
    
    @staticmethod
    def get_process(process_id: int, include_deleted: bool = False) -> Optional[Dict[str, Any]]:
        """
        Get a process by ID with complete structure.
        
        Args:
            process_id: The process ID
            include_deleted: Whether to include soft-deleted processes
        
        Returns:
            Complete process structure with subprocesses, variants, costs
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (conn, cur):
            # Get process
            deleted_clause = "" if include_deleted else "AND is_deleted = FALSE"
            cur.execute(f"""
                SELECT * FROM processes
                WHERE id = %s {deleted_clause}
            """, (process_id,))
            
            process_data = cur.fetchone()
            
            if not process_data:
                return None
            
            # Get subprocesses
            cur.execute("""
                SELECT 
                    ps.id as process_subprocess_id,
                    ps.subprocess_id,
                    ps.custom_name,
                    ps.sequence_order,
                    ps.notes,
                    s.name as subprocess_name,
                    s.description as subprocess_description
                FROM process_subprocesses ps
                JOIN subprocesses s ON s.id = ps.subprocess_id
                WHERE ps.process_id = %s
                ORDER BY ps.sequence_order
            """, (process_id,))
            
            subprocesses = cur.fetchall()
        
        process = Process(process_data)
        result = process.to_dict()
        result['subprocesses'] = [dict(sp) for sp in subprocesses]
        
        return result
    
    @staticmethod
    def get_process_full_structure(process_id: int) -> Optional[Dict[str, Any]]:
        """
        Get complete process structure including all variants, costs, and groups.
        
        This is the main method for loading a process in the editor.
        """
        process = ProcessService.get_process(process_id)
        if not process:
            return None
        
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (conn, cur):
            # For each subprocess, get its details
            for subprocess in process['subprocesses']:
                ps_id = subprocess['process_subprocess_id']
                
                # Get variants (non-substitute)
                cur.execute("""
                    SELECT 
                        vu.*,
                        iv.name as variant_name,
                        iv.opening_stock
                    FROM variant_usage vu
                    JOIN item_variant iv ON iv.variant_id = vu.variant_id
                    WHERE vu.process_subprocess_id = %s
                      AND (vu.substitute_group_id IS NULL OR vu.is_alternative = FALSE)
                """, (ps_id,))
                subprocess['variants'] = [dict(v) for v in cur.fetchall()]
                
                # Get cost items
                cur.execute("""
                    SELECT * FROM cost_items
                    WHERE process_subprocess_id = %s
                """, (ps_id,))
                subprocess['cost_items'] = [dict(ci) for ci in cur.fetchall()]
                
                # Get substitute groups with their alternatives
                cur.execute("""
                    SELECT * FROM substitute_groups
                    WHERE process_subprocess_id = %s
                """, (ps_id,))
                groups = cur.fetchall()
                
                subprocess['substitute_groups'] = []
                for group in groups:
                    cur.execute("""
                        SELECT 
                            vu.*,
                            iv.name as variant_name,
                            iv.opening_stock
                        FROM variant_usage vu
                        JOIN item_variant iv ON iv.variant_id = vu.variant_id
                        WHERE vu.substitute_group_id = %s
                          AND vu.is_alternative = TRUE
                        ORDER BY vu.alternative_order
                    """, (group['id'],))
                    
                    group_dict = dict(group)
                    group_dict['alternatives'] = [dict(alt) for alt in cur.fetchall()]
                    subprocess['substitute_groups'].append(group_dict)
                
                # Get timing
                cur.execute("""
                    SELECT * FROM process_timing
                    WHERE process_subprocess_id = %s
                """, (ps_id,))
                timing = cur.fetchone()
                subprocess['timing'] = dict(timing) if timing else None
            
            # Get additional costs
            cur.execute("""
                SELECT * FROM additional_costs
                WHERE process_id = %s
            """, (process_id,))
            process['additional_costs'] = [dict(ac) for ac in cur.fetchall()]
            
            # Get profitability
            cur.execute("""
                SELECT * FROM profitability
                WHERE process_id = %s
            """, (process_id,))
            profitability = cur.fetchone()
            process['profitability'] = dict(profitability) if profitability else None
        
        return process
    
    @staticmethod
    def list_processes(
        user_id: int,
        status: Optional[str] = None,
        include_deleted: bool = False,
        page: int = 1,
        per_page: int = 25
    ) -> Dict[str, Any]:
        """
        List processes with pagination and filtering.
        
        Args:
            user_id: Filter by user ID
            status: Optional status filter
            include_deleted: Whether to include soft-deleted processes
            page: Page number (1-indexed)
            per_page: Items per page
        
        Returns:
            Dict with processes list and pagination info
        """
        offset = (page - 1) * per_page
        
        conditions = ["user_id = %s"]
        params = [user_id]
        
        if status:
            conditions.append("status = %s")
            params.append(status)
        
        if not include_deleted:
            conditions.append("is_deleted = FALSE")
        
        where_clause = " AND ".join(conditions)
        
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (conn, cur):
            # Get total count
            cur.execute(f"""
                SELECT COUNT(*) as total
                FROM processes
                WHERE {where_clause}
            """, params)
            total = cur.fetchone()['total']
            
            # Get page of results
            cur.execute(f"""
                SELECT 
                    p.*,
                    COUNT(ps.id) as subprocess_count
                FROM processes p
                LEFT JOIN process_subprocesses ps ON ps.process_id = p.id
                WHERE {where_clause}
                GROUP BY p.id
                ORDER BY p.created_at DESC
                LIMIT %s OFFSET %s
            """, params + [per_page, offset])
            
            processes = cur.fetchall()
        
        return {
            'processes': [dict(p) for p in processes],
            'pagination': {
                'page': page,
                'per_page': per_page,
                'total': total,
                'pages': (total + per_page - 1) // per_page,
            }
        }
    
    @staticmethod
    def update_process(
        process_id: int,
        name: Optional[str] = None,
        description: Optional[str] = None,
        process_class: Optional[str] = None,
        status: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Update process details.
        
        Args:
            process_id: The process ID
            name: Optional new name
            description: Optional new description
            process_class: Optional new class
            status: Optional new status
        
        Returns:
            Updated process or None if not found
        """
        updates = []
        params = []
        
        if name is not None:
            updates.append("name = %s")
            params.append(name)
        if description is not None:
            updates.append("description = %s")
            params.append(description)
        if process_class is not None:
            updates.append("class = %s")
            params.append(process_class)
        if status is not None:
            updates.append("status = %s")
            params.append(status)
        
        if not updates:
            return ProcessService.get_process(process_id)
        
        updates.append("updated_at = CURRENT_TIMESTAMP")
        params.append(process_id)
        
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (conn, cur):
            cur.execute(f"""
                UPDATE processes
                SET {', '.join(updates)}
                WHERE id = %s AND is_deleted = FALSE
                RETURNING *
            """, params)
            
            process_data = cur.fetchone()
            conn.commit()
        
        if not process_data:
            return None
        
        process = Process(process_data)
        return process.to_dict()
    
    @staticmethod
    def delete_process(process_id: int, hard_delete: bool = False) -> bool:
        """
        Delete a process (soft delete by default).
        
        Args:
            process_id: The process ID
            hard_delete: If True, permanently delete; if False, soft delete
        
        Returns:
            True if successful, False if not found
        """
        with database.get_conn() as (conn, cur):
            if hard_delete:
                cur.execute("""
                    DELETE FROM processes
                    WHERE id = %s
                """, (process_id,))
            else:
                cur.execute("""
                    UPDATE processes
                    SET is_deleted = TRUE,
                        deleted_at = CURRENT_TIMESTAMP
                    WHERE id = %s AND is_deleted = FALSE
                """, (process_id,))
            
            affected = cur.rowcount
            conn.commit()
        
        return affected > 0
    
    @staticmethod
    def restore_process(process_id: int) -> bool:
        """
        Restore a soft-deleted process.
        
        Args:
            process_id: The process ID
        
        Returns:
            True if successful, False if not found
        """
        with database.get_conn() as (conn, cur):
            cur.execute("""
                UPDATE processes
                SET is_deleted = FALSE,
                    deleted_at = NULL
                WHERE id = %s AND is_deleted = TRUE
            """, (process_id,))
            
            affected = cur.rowcount
            conn.commit()
        
        return affected > 0
    
    @staticmethod
    def add_subprocess_to_process(
        process_id: int,
        subprocess_id: int,
        sequence_order: int,
        custom_name: Optional[str] = None,
        notes: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Add a subprocess to a process at specified position.
        
        Args:
            process_id: The process ID
            subprocess_id: The subprocess to add
            sequence_order: Position in sequence
            custom_name: Optional custom name for this instance
            notes: Optional notes
        
        Returns:
            Created process_subprocess association
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (conn, cur):
            cur.execute("""
                INSERT INTO process_subprocesses (
                    process_id, subprocess_id, custom_name, sequence_order, notes
                ) VALUES (%s, %s, %s, %s, %s)
                RETURNING *
            """, (process_id, subprocess_id, custom_name, sequence_order, notes))
            
            ps_data = cur.fetchone()
            conn.commit()
        
        ps = ProcessSubprocess(ps_data)
        return ps.to_dict()
    
    @staticmethod
    def remove_subprocess_from_process(process_subprocess_id: int) -> bool:
        """
        Remove a subprocess from a process.
        
        Args:
            process_subprocess_id: The process_subprocess association ID
        
        Returns:
            True if successful
        """
        with database.get_conn() as (conn, cur):
            cur.execute("""
                DELETE FROM process_subprocesses
                WHERE id = %s
            """, (process_subprocess_id,))
            
            affected = cur.rowcount
            conn.commit()
        
        return affected > 0
    
    @staticmethod
    def reorder_subprocesses(process_id: int, sequence_map: Dict[int, int]) -> bool:
        """
        Reorder subprocesses in a process.
        
        Args:
            process_id: The process ID
            sequence_map: Dict of {process_subprocess_id: new_sequence_order}
        
        Returns:
            True if successful
        """
        with database.get_conn() as (conn, cur):
            for ps_id, new_order in sequence_map.items():
                cur.execute("""
                    UPDATE process_subprocesses
                    SET sequence_order = %s
                    WHERE id = %s AND process_id = %s
                """, (new_order, ps_id, process_id))
            
            conn.commit()
        
        return True
    
    @staticmethod
    def search_processes(query: str, user_id: int) -> List[Dict[str, Any]]:
        """
        Search processes by name or description.
        
        Args:
            query: Search query
            user_id: User ID to filter by
        
        Returns:
            List of matching processes
        """
        search_pattern = f"%{query}%"
        
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (conn, cur):
            cur.execute("""
                SELECT 
                    p.*,
                    COUNT(ps.id) as subprocess_count
                FROM processes p
                LEFT JOIN process_subprocesses ps ON ps.process_id = p.id
                WHERE p.user_id = %s
                  AND p.is_deleted = FALSE
                  AND (p.name ILIKE %s OR p.description ILIKE %s)
                GROUP BY p.id
                ORDER BY p.name
                LIMIT 50
            """, (user_id, search_pattern, search_pattern))
            
            results = cur.fetchall()
        
        return [dict(r) for r in results]
