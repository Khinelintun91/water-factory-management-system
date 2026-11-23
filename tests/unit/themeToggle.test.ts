import { describe, expect, it } from 'vitest'
import { nextToggleChoice, resolvedDark } from '../../src/lib/theme'

// The header theme toggle is a 2-way explicit switch built on the stored
// light/dark/system choice: a tap always picks the opposite of what is
// currently SHOWN. With 'system' stored, that means the explicit
// opposite of the OS-resolved appearance.

describe('resolvedDark', () => {
  it('explicit choices ignore the OS preference', () => {
    expect(resolvedDark('dark', false)).toBe(true)
    expect(resolvedDark('dark', true)).toBe(true)
    expect(resolvedDark('light', false)).toBe(false)
    expect(resolvedDark('light', true)).toBe(false)
  })

  it("'system' follows the OS preference", () => {
    expect(resolvedDark('system', true)).toBe(true)
    expect(resolvedDark('system', false)).toBe(false)
  })
})

describe('nextToggleChoice', () => {
  it('flips explicit choices', () => {
    expect(nextToggleChoice('light', false)).toBe('dark')
    expect(nextToggleChoice('dark', false)).toBe('light')
  })

  it("turns 'system' into the explicit opposite of the resolved appearance", () => {
    expect(nextToggleChoice('system', true)).toBe('light')
    expect(nextToggleChoice('system', false)).toBe('dark')
  })
})
