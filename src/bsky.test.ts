import assert from 'node:assert/strict'
import { test, TestContext } from 'node:test'
import { Bluesky, Like } from './bsky'

/**
 * Explicitly handles the promise returned by node:test registration and rethrows test failures as-is.
 */
function registerTest(
  name: string,
  function_: (context: TestContext) => Promise<void>
): void {
  test(name, function_).catch((error: unknown) => {
    throw error
  })
}

/**
 * Reproduces a transient network error equivalent to ETIMEDOUT.
 */
function transientNetworkError(): Error {
  return new Error('fetch failed', {
    cause: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
  })
}

/**
 * Creates a successful, empty likes API response.
 */
function okLikesResponse(): Response {
  return Response.json({ records: [], cursor: '' })
}

registerTest('succeeds on retry when ETIMEDOUT occurs only once', async (t) => {
  let calls = 0
  t.mock.method(Math, 'random', () => 0)
  t.mock.method(globalThis, 'fetch', () => {
    calls += 1
    return calls === 1
      ? Promise.reject(transientNetworkError())
      : Promise.resolve(okLikesResponse())
  })

  const result = await Bluesky.getUserLikes('did:plc:example')
  assert.deepEqual(result, { records: [], cursor: '' })
  assert.equal(calls, 2)
})

registerTest(
  'finally throws when ETIMEDOUT persists beyond the retry limit',
  async (t) => {
    let calls = 0
    t.mock.method(Math, 'random', () => 0)
    t.mock.method(globalThis, 'fetch', () => {
      calls += 1
      return Promise.reject(transientNetworkError())
    })

    await assert.rejects(
      Bluesky.getUserLikes('did:plc:example'),
      /Failed to fetch \(getUserLikes\).*ETIMEDOUT/
    )
    assert.equal(calls, 3)
  }
)

registerTest(
  'throws immediately on a permanent 404 response without retrying',
  async (t) => {
    let calls = 0
    t.mock.method(globalThis, 'fetch', () => {
      calls += 1
      return Promise.resolve(
        new Response('not found', { status: 404, statusText: 'Not Found' })
      )
    })

    await assert.rejects(
      Bluesky.getUserLikes('did:plc:example'),
      /returned 404/
    )
    assert.equal(calls, 1)
  }
)

registerTest(
  'throws immediately on a TypeError without cause, without retrying',
  async (t) => {
    let calls = 0
    t.mock.method(globalThis, 'fetch', () => {
      calls += 1
      return Promise.reject(new TypeError('boom'))
    })

    await assert.rejects(
      Bluesky.getUserLikes('did:plc:example'),
      /Failed to fetch \(getUserLikes\)/
    )
    assert.equal(calls, 1)
  }
)

registerTest(
  'releases the body of a 503 response, then retries and succeeds',
  async (t) => {
    let calls = 0
    let cancelled = false
    t.mock.method(Math, 'random', () => 0)
    t.mock.method(globalThis, 'fetch', () => {
      calls += 1
      return Promise.resolve(
        calls === 1
          ? new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true
                },
              }),
              { status: 503, statusText: 'Service Unavailable' }
            )
          : okLikesResponse()
      )
    })

    const result = await Bluesky.getUserLikes('did:plc:example')
    assert.deepEqual(result, { records: [], cursor: '' })
    assert.equal(calls, 2)
    assert.equal(cancelled, true)
  }
)

registerTest(
  'finally throws when 503 persists beyond the retry limit',
  async (t) => {
    let calls = 0
    t.mock.method(Math, 'random', () => 0)
    t.mock.method(globalThis, 'fetch', () => {
      calls += 1
      return Promise.resolve(
        new Response('unavailable', {
          status: 503,
          statusText: 'Service Unavailable',
        })
      )
    })

    await assert.rejects(
      Bluesky.getUserLikes('did:plc:example'),
      /returned 503/
    )
    assert.equal(calls, 3)
  }
)

registerTest('retries a 429 response honoring Retry-After', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', () => {
    calls += 1
    return Promise.resolve(
      calls === 1
        ? new Response('rate limited', {
            status: 429,
            headers: { 'Retry-After': '0' },
          })
        : okLikesResponse()
    )
  })

  const result = await Bluesky.getUserLikes('did:plc:example')
  assert.deepEqual(result, { records: [], cursor: '' })
  assert.equal(calls, 2)
})

function likeOf(id: string): Like {
  return {
    uri: `at://did:plc:me/app.bsky.feed.like/${id}`,
    cid: `like-cid-${id}`,
    value: {
      $type: 'app.bsky.feed.like',
      subject: {
        cid: `cid-${id}`,
        uri: `at://did:plc:abc/app.bsky.feed.post/${id}`,
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  }
}

function subjectIds(likes: Like[]): string[] {
  return likes.map((l) => l.value.subject.uri.split('/').pop() ?? '')
}

/**
 * Mocks fetch with pages keyed by the request's cursor query value ('' for none).
 * Returns the cursors requested, in order.
 */
function mockPages(t: TestContext, pages: Record<string, Response>): string[] {
  const requested: string[] = []
  t.mock.method(globalThis, 'fetch', (href: string) => {
    const cursor = new URL(href).searchParams.get('cursor') ?? ''
    requested.push(cursor)
    const page = pages[cursor] as Response | undefined
    return page
      ? Promise.resolve(page)
      : Promise.reject(new TypeError(`unexpected cursor "${cursor}"`))
  })
  return requested
}

registerTest('getUserLikes omits cursor unless one is given', async (t) => {
  const urls: string[] = []
  t.mock.method(globalThis, 'fetch', (href: string) => {
    urls.push(href)
    return Promise.resolve(okLikesResponse())
  })

  await Bluesky.getUserLikes('did:plc:example')
  await Bluesky.getUserLikes('did:plc:example', 'c1')
  assert.equal(new URL(urls[0]).searchParams.has('cursor'), false)
  assert.equal(new URL(urls[1]).searchParams.get('cursor'), 'c1')
})

registerTest(
  'getLikesUntilKnown stops at the page with a known like',
  async (t) => {
    const requested = mockPages(t, {
      '': Response.json({ records: [likeOf('5'), likeOf('4')], cursor: 'c1' }),
      c1: Response.json({
        records: [likeOf('3'), likeOf('2'), likeOf('1')],
        cursor: 'c2',
      }),
    })

    const likes = await Bluesky.getLikesUntilKnown(
      'did:plc:example',
      (like) => like.value.subject.cid === 'cid-2'
    )
    assert.deepEqual(requested, ['', 'c1'])
    assert.deepEqual(subjectIds(likes), ['5', '4', '3', '2', '1'])
  }
)

registerTest(
  'getLikesUntilKnown walks to the last page when nothing is known',
  async (t) => {
    const requested = mockPages(t, {
      '': Response.json({ records: [likeOf('3')], cursor: 'c1' }),
      c1: Response.json({ records: [likeOf('2')], cursor: 'c2' }),
      c2: Response.json({ records: [likeOf('1')] }),
    })

    const likes = await Bluesky.getLikesUntilKnown(
      'did:plc:example',
      () => false
    )
    assert.deepEqual(requested, ['', 'c1', 'c2'])
    assert.deepEqual(subjectIds(likes), ['3', '2', '1'])
  }
)

registerTest(
  'getLikesUntilKnown fetches one page when everything is known',
  async (t) => {
    const requested = mockPages(t, {
      '': Response.json({ records: [likeOf('2'), likeOf('1')], cursor: 'c1' }),
    })

    const likes = await Bluesky.getLikesUntilKnown(
      'did:plc:example',
      () => true
    )
    assert.deepEqual(requested, [''])
    assert.deepEqual(subjectIds(likes), ['2', '1'])
  }
)

registerTest(
  'getLikesUntilKnown returns a repeated subject once',
  async (t) => {
    mockPages(t, {
      '': Response.json({ records: [likeOf('2'), likeOf('1')], cursor: 'c1' }),
      c1: Response.json({ records: [likeOf('1'), likeOf('0')] }),
    })

    const likes = await Bluesky.getLikesUntilKnown(
      'did:plc:example',
      () => false
    )
    assert.deepEqual(subjectIds(likes), ['2', '1', '0'])
  }
)

registerTest(
  'getLikesUntilKnown stops when the cursor does not advance',
  async (t) => {
    const requested = mockPages(t, {
      '': Response.json({ records: [likeOf('2')], cursor: 'c1' }),
      c1: Response.json({ records: [likeOf('1')], cursor: 'c1' }),
    })

    const likes = await Bluesky.getLikesUntilKnown(
      'did:plc:example',
      () => false
    )
    assert.deepEqual(requested, ['', 'c1'])
    assert.deepEqual(subjectIds(likes), ['2', '1'])
  }
)

registerTest(
  'getLikesUntilKnown stops on an empty page that carries a cursor',
  async (t) => {
    const requested = mockPages(t, {
      '': Response.json({ records: [], cursor: 'c1' }),
    })

    const likes = await Bluesky.getLikesUntilKnown(
      'did:plc:example',
      () => false
    )
    assert.deepEqual(requested, [''])
    assert.deepEqual(likes, [])
  }
)

registerTest(
  'getLikesUntilKnown rejects without partial results when a later page fails',
  async (t) => {
    mockPages(t, {
      '': Response.json({ records: [likeOf('2')], cursor: 'c1' }),
      c1: new Response('not found', { status: 404, statusText: 'Not Found' }),
    })

    await assert.rejects(
      Bluesky.getLikesUntilKnown('did:plc:example', () => false),
      /returned 404/
    )
  }
)
