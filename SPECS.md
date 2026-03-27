# Design guidelines

## Server
- Organized in microservices
- Use python for prototyping, nodejs (typescript) for highly concurrent services, and golang for performance critical services
- Dockerized, with docker-compose for both local and remote (production) deployment
- Production runs in a single server (raspberry4.tail263330.ts.net), so all services must be designed to run on a single machine with limited resources. prioritize efficiency and low resource usage.
- Use environment variables for configuration, with .env files for local development and production.

## Queue and task management
- Use some simple queue system, outside the code (e.g. redis, rabbitmq)
- Tasks should be idempotent and retryable, with exponential backoff for retries. Log all task executions, including retries and failures, for monitoring and debugging purposes.

## Client
- React SPA, tailwind, material UI
- Compact UI
- Tables must be single-line, dense. No oversized cards or spacing.
- Accessibility: color-blind friendly, high-contrast filled states, explicit labels. do not rely on red/green alone to convey meaning. If using red/green, use background colors, not text colors, and bluish green and orangish red to maximize contrast for color-blind users.
- Use paths for different views, different steps, ... avoid popups unless its a very simple action.

## Protocol
- OpenAPI for simple apis
- Websockets for real-time updates and streaming data

## Prediction, guessing, and recommendation features:
- Use a combination of heuristics, metadata, and machine learning to predict missing metadata, suggest similar songs, and recommend new music.
- Log all predictions and recommendations along with their features and confidence scores for future analysis and improvement.
- Continuously evaluate the performance of prediction and recommendation algorithms using metrics like accuracy, precision, recall, and user feedback.
- Every prediction must be overridable. For example predicted tags must be editable by the user, matching songs must be confirmable by the user, and recommendations must be dismissable by the user. This allows for a feedback loop to improve the algorithms over time.

## Specific tagging conventions:
- In order to be usable from reakordbox, we'll use the comments tag (ID3v2: COMM frame) to store tags in the format: tag_xxx; tag_yyy; tag_zzz. Example of tags: tag_base (percussion songs to be used as base), tag_melody, tag_vocals, tag_javi (music from my friend Javi), ...```
- Special tags:
  - tag_replaced: for songs that have been replaced by a better quality version and need to be reanalyzed in rekordbox

## Persistence
- Most of the persistence is the music library itself, which is in dropbox
- For other data (wantlist, search history, predictions, recommendations, ...) we'll use a simple sqlite database.
- (long) running processes also should be persisted. For example wantlist item has a lifecycle, searches to soulseek, etc, this must be persisted.

# FEATURES
## Search and discovery
- Discogs search and browse UI
- Add tracks to wantlist
## Wantlist
- View and manage wantlist, including adding/removing tracks, and viewing track details. Wantlist item can contain a lot of preset fields, for example if the wantlist item comes from discogs, we already have artist, title, album, year, genre, style, label, discogs id, track number, ... If we download and import from that page, we can skip the metadata search.

## Download
- There will be a slskd server that will be controled by API. Download can be initiated from several places: from the wantlist, from the search results, from the collection if we want to redownload a track, ...

## Mass Import music
Sometimes somebody sends us a lot of music files. We need a bulk import feature that allows us:
- Table with all the music
- Mass tagging for example tag_javi for songs coming from Javi
- Sometimes it comes in subfolders or some kind of organization so we can tag. For example subfolder xque = tag_xque, think on some very flexible way of doing this, maybe just multiselecting in the table and then applying tags to all selected items.
- Optionally: mass search and rename to do some preliminar cleaning of filename and metadata.
- Provide also some reorganization features, sometimes files come in weird folder structures, and we want mostly flat with tags when mass importing.
- After this, the standard import flow applies.

## Import music
- Import = tagging, renaming and moving to our songs folder, organized by year/artist - title (version).mp3
- If it comes from a pretagged wantlist we can skip the metadata search and just apply the tags from the wantlist item.
- If not, we need to identify the song. Search in discogs, and potentially other services
- Then we need to identify if we already have it in our collection, to avoid duplicates. This is a hard problem, because metadata can be very inconsistent. We can use a combination of heuristics, metadata, and machine learning to predict if a song matches an existing one in our collection. But we should always ask the user to confirm if the match is correct or not, to avoid false positives and false negatives.
- If we find a match we need to provide a good UI to compare the two songs:
  - Show metadata side by side
  - Show audio features side by side (LUFS, LRA, true peak, RMS, crest, noise floor, low-band RMS, high-band RMS, sample rate, bit depth, bitrate, and file size)
  - Double player with crossfade
- Then we can choose:
  - import (if we didn't find a match)
  - replace (if we found a match and the new one is better quality, for example). In this case we'll apply the special tag tag_replaced, because it will need to be reanalyzed in rekordbox.
  - delete (if we found a match and the new one is not better quality)
- Clean empty folders after import

## Collection management:
- Edit song metadata (tags, title, artist, album, etc.)
- Find duplicates.
