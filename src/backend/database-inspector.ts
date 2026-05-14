import { Pool } from 'pg'
import {
  buildDatabaseFieldActions,
  buildDatabaseRowActions,
  decodeDatabaseRowKey,
  encodeDatabaseRowKey,
  type DatabaseCellValue,
  type DatabaseColumn,
  type DatabaseRow,
  type DatabaseRowDetails,
  type DatabaseRowKey,
  type DatabaseTableRows,
  type DatabaseTableSummary
} from '../shared/database-inspector.ts'
import { toNumber } from './collection-service-helpers.ts'

const MAX_LIMIT = 200
const SECRET_COLUMN = /(?:password|secret|token|api_?key)$/iu

export class DatabaseInspector {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString })
  }

  public async dispose(): Promise<void> {
    await this.pool.end()
  }

  public async listTables(): Promise<DatabaseTableSummary[]> {
    const rows = (
      await this.pool.query<{ table_name: string }>(
        `
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name
        `
      )
    ).rows
    return Promise.all(rows.map((row) => this.readTable(row.table_name)))
  }

  public async listRows(tableName: string, filter = '', rawLimit = 50, rawOffset = 0): Promise<DatabaseTableRows> {
    const table = await this.readTable(tableName)
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
    const offset = Math.max(0, Math.floor(rawOffset))
    const cols = table.columns.map((column) => quote(column.name))
    const params: unknown[] = []
    const where = this.filterSql(table, filter, params)
    const order = table.primaryKey.length ? `ORDER BY ${table.primaryKey.map(quote).join(', ')}` : ''
    const rows = (
      await this.pool.query<Record<string, unknown>>(
        `SELECT ctid::text AS "__ctid", ${cols.join(', ')} FROM ${quote(table.name)} ${where} ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      )
    ).rows
    return { table, rows: rows.map((row) => this.toRow(table, row)), filter, limit, offset }
  }

  public async getRow(tableName: string, encodedKey: string): Promise<DatabaseRowDetails | null> {
    const table = await this.readTable(tableName)
    const key = decodeDatabaseRowKey(encodedKey)
    const params: unknown[] = []
    const where = this.keySql(table, key, params)
    const row = (
      await this.pool.query<Record<string, unknown>>(
        `SELECT ctid::text AS "__ctid", ${table.columns.map((column) => quote(column.name)).join(', ')} FROM ${quote(table.name)} WHERE ${where} LIMIT 1`,
        params
      )
    ).rows[0]
    if (!row) return null
    const base = this.toRow(table, row)
    return {
      ...base,
      table,
      fieldActions: Object.fromEntries(table.columns.map((column) => [
        column.name,
        buildDatabaseFieldActions(column.name, base.values[column.name] ?? null, column.reference)
      ]))
    }
  }

  private async readTable(name: string): Promise<DatabaseTableSummary> {
    const table = (
      await this.pool.query<{ table_name: string }>(
        `
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name = $1
        `,
        [name]
      )
    ).rows[0]
    if (!table) throw new Error(`Unknown database table: ${name}`)
    const [columns, primaryKey, references, count] = await Promise.all([
      this.readColumns(name),
      this.readPrimaryKey(name),
      this.readReferences(name),
      this.pool.query<{ total: number | bigint }>(`SELECT COUNT(*) AS total FROM ${quote(name)}`)
    ])
    return {
      name,
      rowCount: toNumber(count.rows[0]?.total ?? 0),
      primaryKey,
      columns: columns.map((column) => ({ ...column, isPrimaryKey: primaryKey.includes(column.name), reference: references.get(column.name) ?? null }))
    }
  }

  private async readColumns(table: string): Promise<DatabaseColumn[]> {
    return (
      await this.pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position
        `,
        [table]
      )
    ).rows.map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === 'YES',
      isPrimaryKey: false,
      reference: null
    }))
  }

  private async readPrimaryKey(table: string): Promise<string[]> {
    return (
      await this.pool.query<{ column_name: string }>(
        `
          SELECT key_usage.column_name
          FROM information_schema.table_constraints constraints
          JOIN information_schema.key_column_usage key_usage
            ON key_usage.constraint_schema = constraints.constraint_schema
           AND key_usage.constraint_name = constraints.constraint_name
          WHERE constraints.table_schema = 'public' AND constraints.table_name = $1 AND constraints.constraint_type = 'PRIMARY KEY'
          ORDER BY key_usage.ordinal_position
        `,
        [table]
      )
    ).rows.map((row) => row.column_name)
  }

  private async readReferences(table: string): Promise<Map<string, { foreignTable: string; foreignColumn: string }>> {
    const map = new Map<string, { foreignTable: string; foreignColumn: string }>()
    const rows = (
      await this.pool.query<{ column_name: string; foreign_table_name: string; foreign_column_name: string }>(
        `
          SELECT key_usage.column_name, column_usage.table_name AS foreign_table_name, column_usage.column_name AS foreign_column_name
          FROM information_schema.table_constraints constraints
          JOIN information_schema.key_column_usage key_usage
            ON key_usage.constraint_schema = constraints.constraint_schema
           AND key_usage.constraint_name = constraints.constraint_name
          JOIN information_schema.constraint_column_usage column_usage
            ON column_usage.constraint_schema = constraints.constraint_schema
           AND column_usage.constraint_name = constraints.constraint_name
          WHERE constraints.table_schema = 'public' AND constraints.table_name = $1 AND constraints.constraint_type = 'FOREIGN KEY'
        `,
        [table]
      )
    ).rows
    for (const row of rows) map.set(row.column_name, { foreignTable: row.foreign_table_name, foreignColumn: row.foreign_column_name })
    return map
  }

  private filterSql(table: DatabaseTableSummary, filter: string, params: unknown[]): string {
    const value = filter.trim()
    if (!value) return ''
    params.push(`%${value}%`)
    return `WHERE concat_ws(' ', ${table.columns.map((column) => `COALESCE(${quote(column.name)}::text, '')`).join(', ')}) ILIKE $${params.length}`
  }

  private keySql(table: DatabaseTableSummary, key: DatabaseRowKey, params: unknown[]): string {
    if (key.kind === 'ctid') {
      params.push(key.value)
      return `ctid = $${params.length}::tid`
    }
    const clauses = table.primaryKey.map((column) => {
      const value = key.values[column]
      if (value === undefined) throw new Error('Invalid database row key.')
      params.push(value)
      return `${quote(column)} = $${params.length}`
    })
    if (clauses.length === 0) throw new Error('Invalid database row key.')
    return clauses.join(' AND ')
  }

  private toRow(table: DatabaseTableSummary, row: Record<string, unknown>): DatabaseRow {
    const values = Object.fromEntries(table.columns.map((column) => [column.name, serialize(column.name, row[column.name])]))
    const key = table.primaryKey.length
      ? encodeDatabaseRowKey({ kind: 'pk', values: Object.fromEntries(table.primaryKey.map((column) => [column, values[column] ?? null])) })
      : encodeDatabaseRowKey({ kind: 'ctid', value: String(row['__ctid']) })
    return { key, values, actions: buildDatabaseRowActions(table.name, values) }
  }
}

function serialize(column: string, value: unknown): DatabaseCellValue {
  if (value == null) return null
  if (SECRET_COLUMN.test(column)) return 'redacted'
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || Array.isArray(value)) return value
  if (typeof value === 'object') return value as Record<string, unknown>
  return String(value)
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}
