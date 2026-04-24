#!/usr/bin/env node
import { main } from '../dist/index.js'
import pc from 'picocolors'

main().catch((err) => {
  console.error(pc.red('✗ create-nymbal-app failed'))
  console.error(err)
  process.exit(1)
})
