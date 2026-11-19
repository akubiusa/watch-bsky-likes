import { Notified } from './notified'
import { Configuration } from './config'
import { Discord, Logger } from '@book000/node-utils'
import { Bluesky, Like } from './bsky'
import { processLikes, selectUnnotifiedOldestFirst } from './process-likes'

async function main() {
  const logger = Logger.configure('main')

  const config = new Configuration('data/config.json')
  config.load()
  if (!config.validate()) {
    logger.error('❌ Configuration is invalid')
    logger.error(
      `💡 Missing check(s): ${config.getValidateFailures().join(', ')}`
    )
    return
  }

  const discord = new Discord(config.get('discord'))

  const isFirst = Notified.isFirst()

  const isNotified = (like: Like) => Notified.isNotified(like.value.subject.uri)

  // On the first run only the newest page is fetched as the baseline
  const likes = await Bluesky.getLikesUntilKnown(
    'hiratake.dev',
    isFirst ? () => true : isNotified
  )
  const filteredResults = selectUnnotifiedOldestFirst(likes, isNotified)

  const postDetails = await Bluesky.getPosts(
    filteredResults.map((r) => r.value.subject.uri)
  )

  await processLikes(filteredResults, postDetails, discord, isFirst)
}

;(async () => {
  try {
    await main()
  } catch (error) {
    // Prevent main() rejections (e.g. fetch network errors) from escaping
    // as an unhandledRejection and crashing the process
    const logger = Logger.configure('main')
    logger.error('❌ Unhandled error in main', error as Error)
    process.exitCode = 1
  }
})()
