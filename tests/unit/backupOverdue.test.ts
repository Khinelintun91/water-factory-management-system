import { describe, expect, it } from 'vitest'
import { isBackupOverdue } from '../../src/lib/backup'

const DAY = 24 * 60 * 60 * 1000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

describe('isBackupOverdue', () => {
  it('is overdue when no backup has ever been taken', () => {
    expect(isBackupOverdue(null)).toBe(true)
  })

  it('is not overdue for a fresh or recent backup', () => {
    expect(isBackupOverdue(ago(0))).toBe(false)
    expect(isBackupOverdue(ago(6 * DAY))).toBe(false)
  })

  it('is overdue at and beyond 7 days', () => {
    expect(isBackupOverdue(ago(7 * DAY))).toBe(true)
    expect(isBackupOverdue(ago(30 * DAY))).toBe(true)
  })
})
