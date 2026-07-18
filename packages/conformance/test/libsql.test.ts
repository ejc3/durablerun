import { schedulerConformance } from '../src/index.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

schedulerConformance('libsql', makeLibsqlFixture)
