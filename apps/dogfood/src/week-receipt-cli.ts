import { checkWeekReceiptFile } from './week-receipt.js'

process.exitCode = checkWeekReceiptFile(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
})
