import { StoreUnavailableError } from '@durablerun/core'
import { createConnection } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import { MysqlExecutor, createOwnedMysqlPool } from '../src/executor.js'
import { openMysqlTestDb } from '../src/testing.js'

/**
 * How the executor types what a real MySQL server answers. The executor's own cases run on
 * a fake connection that is fed the numbers their author listed, so they can only agree
 * with that list. These cases ask the server. They need one, as the conformance suite's
 * MySQL leg does, and are never conditional.
 */

const serverUrl = (): string => {
  const url = process.env.DURABLERUN_MYSQL_URL
  if (!url) throw new Error('these cases need DURABLERUN_MYSQL_URL')
  return url
}

describe('MysqlExecutor error typing against a real server', () => {
  it('types an account past its connection limit an outage, and the same batch is answered once a connection is free', async () => {
    const db = await openMysqlTestDb({ idNamespace: 'connection-limit' })
    const control = createOwnedMysqlPool({ uri: serverUrl(), connectionLimit: 1 })
    // An account of this case's own, held to one connection. The limit is the account's:
    // no setting of the server moves, so nothing else connected to it can meet the limit.
    const account = `dr_limit_${db.databaseName.slice(-16)}`
    const limited = new URL(serverUrl())
    limited.username = account
    limited.password = 'one-connection'
    limited.pathname = `/${db.databaseName}`
    let executor: MysqlExecutor | undefined
    try {
      await control.query(
        `CREATE USER '${account}'@'%' IDENTIFIED BY 'one-connection' WITH MAX_USER_CONNECTIONS 1`,
      )
      await control.query(`GRANT ALL ON ${db.databaseName}.* TO '${account}'@'%'`)
      const holder = await createConnection(limited.href)
      executor = MysqlExecutor.open(limited.href)
      const batch = () =>
        (executor as MysqlExecutor)
          .batch('fixture:one-more-connection', [{ sql: 'SELECT 1 AS answered', args: [] }], 'read')
          .then(
            () => 'answered',
            (error: unknown) => error,
          )
      const refused = await batch()
      expect(String(refused)).toContain('MySQL error 1226')
      expect(refused).toBeInstanceOf(StoreUnavailableError)

      // The retry an outage invites works: the server frees the account's slot a moment
      // after the holder's connection ends.
      await holder.end()
      let retried: unknown = refused
      for (let attempt = 0; attempt < 100 && retried !== 'answered'; attempt++) {
        retried = await batch()
        if (retried !== 'answered') await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(retried).toBe('answered')
    } finally {
      await executor?.close()
      await control.query(`DROP USER IF EXISTS '${account}'@'%'`)
      await control.end()
      await db.close()
    }
  })
})
