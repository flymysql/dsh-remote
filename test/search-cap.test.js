// The cap-exact tail of the rw_search hardening line started in issue #44
// (commit 13408a4 "fix(search): make rw_search cancellable and bounded" —
// its suite is test/search-cancel.test.js). #44 made the SFTP walk
// cancellable, but one defect survived inside the cap itself: when `matches`
// reached `maxMatches` exactly on a file's LAST matching line and no further
// match ever arrived, nothing ever set `truncated`. The only writers of
// `truncated` were the "a further match arrived past the cap" guards, and the
// per-entry guard in the file loop skips every remaining file UNREAD — so no
// further match could arrive. shouldStop() therefore never fired, and the
// directory loop kept spending one SFTP readdir round-trip on every remaining
// directory, ending either with truncated:false while silently dropping later
// matches (an integrity lie) or with a TRUNCATED report only after
// maxDurationMs burned.
//
// The fix: a full cap is itself the honest truncation signal — there may be
// more matches beyond it in files this walk never reads — so shouldStop() now
// flags `truncated` and stops the walk the moment matches.length reaches
// maxMatches. Cancellation semantics are unchanged.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchTree } from '../lib/search.js'
import { MemFs, makeSftp, seed } from './helpers.js'

const noIgnore = () => false

/** In-memory sftp (helpers.js MemFs) that records every readdir round-trip. */
function countingSftp(fs, readDirs) {
  const sftp = makeSftp(fs)
  const orig = sftp.readdir
  sftp.readdir = (d) => { readDirs.push(d); return orig(d) }
  return sftp
}

test('cap filled exactly on the last line stops the walk before remaining dirs', async () => {
  const fs = new MemFs()
  seed(fs, {
    // Three hits with cap 3: the cap fills exactly on x.txt's LAST matching
    // line, so no further match ever arrives to trigger the old truncation
    // guards — this is the exact case the walk used to grind on.
    'proj/a/x.txt': 'hit one\nhit two\nhit three',
    'proj/b/keep.txt': 'hit later', // remaining dir — must never be readdir-ed
    'proj/c/note.txt': 'hit more',  // remaining dir — must never be readdir-ed
  })
  const readDirs = []
  const sftp = countingSftp(fs, readDirs)
  const r = await searchTree(sftp, '/proj', {
    regex: /hit/, maxMatches: 3, maxScanBytes: 1024, isIgnored: noIgnore,
  })
  assert.equal(r.matches.length, 3, 'the cap is filled exactly')
  assert.equal(r.truncated, true, 'a full cap must be reported as truncated (there may be more matches beyond it)')
  assert.deepEqual(readDirs, ['/proj', '/proj/a'],
    'the walk must stop at the cap instead of readdir-ing every remaining directory')
})

test('a real match beyond the cap is dropped by design but the output says truncated', async () => {
  const fs = new MemFs()
  seed(fs, {
    'proj/a/x.txt': 'hit one\nhit two\nhit three', // fills the cap exactly
    'proj/b/y.txt': 'hit four',                    // a real match beyond the cap
  })
  const readDirs = []
  const sftp = countingSftp(fs, readDirs)
  const r = await searchTree(sftp, '/proj', {
    regex: /hit/, maxMatches: 3, maxScanBytes: 1024, isIgnored: noIgnore,
  })
  assert.equal(r.matches.length, 3, 'matches stay capped at maxMatches')
  assert.ok(!r.matches.some((m) => m.path === '/proj/b/y.txt'),
    'the beyond-cap match is dropped by design (the walk stops at the cap)')
  assert.equal(r.truncated, true,
    'dropping a real match must be reported — truncated is the honesty signal')
  assert.deepEqual(readDirs, ['/proj', '/proj/a'],
    'the later directory is not walked just to drop its matches unread')
})

test('small tree under the cap is unchanged: everything fits, truncated stays false', async () => {
  const fs = new MemFs()
  seed(fs, {
    'proj/a/x.txt': 'hit one\nplain line\nhit two',
    'proj/b/keep.txt': 'hit three',
    'proj/c/note.txt': 'no match here',
  })
  const readDirs = []
  const sftp = countingSftp(fs, readDirs)
  const r = await searchTree(sftp, '/proj', {
    regex: /hit/, maxMatches: 500, maxScanBytes: 1024, isIgnored: noIgnore,
  })
  assert.equal(r.matches.length, 3, 'all matches are returned')
  assert.equal(r.truncated, false, 'nothing was dropped, so nothing is truncated')
  assert.deepEqual(readDirs, ['/proj', '/proj/a', '/proj/b', '/proj/c'],
    'the whole small tree is still walked')
})
