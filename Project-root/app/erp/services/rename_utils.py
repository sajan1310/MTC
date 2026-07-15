"""Shared helpers for the rename-cascade functions ported from
module_units.js#_renameUnitEverywhere and module_tags.js#_renameColorEverywhere/
_renameProcessTypeEverywhere.

Uses to_regclass() to silently skip tables that don't exist yet, the SQL
equivalent of the source's try/catch around a missing sheet -- and critically
safer than a literal try/except translation, since to_regclass() never raises
and so can't poison the enclosing transaction the way an UPDATE against a
nonexistent table would.

`table`/`column` arguments always come from our own config (config_maps.
TABLE_NAMES + to_snake_case of hardcoded field literals), never from request
input, so the f-string interpolation of identifiers below is not a SQL
injection risk.
"""

from __future__ import annotations


def _table_exists(cur, table: str) -> bool:
    # Aliased so this works under both a plain tuple cursor and the
    # RealDictCursor database.transactional uses (which has no positional
    # [0] access -- only column-name keys).
    cur.execute("SELECT to_regclass(%s) AS relid", (table,))
    return cur.fetchone()["relid"] is not None


def rename_in_column(cur, table: str, column: str, old: str, new: str) -> None:
    """UPDATE table SET column = new WHERE lower(column) = lower(old).

    No-ops silently if `table` doesn't exist yet in this phase.
    """
    if not _table_exists(cur, table):
        return
    cur.execute(
        f"UPDATE {table} SET {column} = %s "
        f"WHERE lower({column}) = lower(%s) AND deleted_at IS NULL",
        (new, old),
    )


def rename_in_either_column(cur, table: str, column_a: str, column_b: str, old: str, new: str) -> None:
    """Like rename_in_column, but for a value that may live in either of two
    columns on the same row (module_tags.js's PROCESS_COLOR_LINKS_COL: a
    paired color lives in COLOR_A or COLOR_B depending on which side of the
    (directional) link row it's on).
    """
    if not _table_exists(cur, table):
        return
    cur.execute(
        f"""
        UPDATE {table}
        SET {column_a} = CASE WHEN lower({column_a}) = lower(%(old)s) THEN %(new)s ELSE {column_a} END,
            {column_b} = CASE WHEN lower({column_b}) = lower(%(old)s) THEN %(new)s ELSE {column_b} END
        WHERE deleted_at IS NULL
          AND (lower({column_a}) = lower(%(old)s) OR lower({column_b}) = lower(%(old)s))
        """,
        {"old": old, "new": new},
    )
