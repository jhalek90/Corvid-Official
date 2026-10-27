// The database connectors' least-privilege advice (#90), shown in the connection form with a copy button and in
// docs/CONNECTORS.md. Placeholder names and password only: the user picks their own.

export const DB_RUNTIMES = ['postgres', 'mysql', 'mssql', 'sqlite'] as const

export const DB_ADVICE =
  'Give agents their own database user with the least privileges that work: read-only where you can, and never an owner or admin account. Corvid also limits what runs, but the database is the last line.'

/** A copyable example that makes a read-only user for agents, per database. Placeholder names and password. */
export const LEAST_PRIVILEGE: Record<'postgres' | 'mysql' | 'mssql' | 'sqlite', string> = {
  postgres: [
    "CREATE ROLE corvid_agent LOGIN PASSWORD 'choose-a-long-random-password';",
    'GRANT CONNECT ON DATABASE mydb TO corvid_agent;',
    'GRANT USAGE ON SCHEMA public TO corvid_agent;',
    'GRANT SELECT ON ALL TABLES IN SCHEMA public TO corvid_agent;',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO corvid_agent;',
    'ALTER ROLE corvid_agent SET default_transaction_read_only = on;'
  ].join('\n'),
  mysql: ["CREATE USER 'corvid_agent'@'%' IDENTIFIED BY 'choose-a-long-random-password';", "GRANT SELECT, SHOW VIEW ON mydb.* TO 'corvid_agent'@'%';"].join('\n'),
  mssql: [
    "CREATE LOGIN corvid_agent WITH PASSWORD = 'choose-a-long-random-password';", // a placeholder (secret-scan: allow)
    'USE mydb;',
    'CREATE USER corvid_agent FOR LOGIN corvid_agent;',
    "ALTER ROLE db_datareader ADD MEMBER corvid_agent;",
    'DENY EXECUTE TO corvid_agent;'
  ].join('\n'),
  sqlite: '-- SQLite has no users. Point the connection at a copy of the file if agents should only read, and keep the safety level at Approve writes or Strict.'
}
