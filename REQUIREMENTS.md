BASIC NEEDS
- I want my collection to be organized
- I want my songs to be correctly tagged
- I want to have good quality versions of my songs
- I don't want to have duplicates
- I want to be able to use discogs to search for music and add it to my wantlist. Also to tag my songs.
- For songs in download folders, the steps should be: 1. analyze. 2. identify in discogs, store in the db clean artist, title, ... but do not modify or rename the file yet. 3. check if we have this version, replace if its better, delete if its worse, delete if we don't want it, or import if we want it (rename + tag + relocate).
- If a download is expected to auto-identify, it must start from a Discogs reference, not from a raw Soulseek/manual search.
- For DJ use, prefer lossless or `mp3 320 kbps`. VBR or weird average bitrates like `171 kbps` are suspicious.
- Significant duration drift versus the reference track is suspicious. Example: expected `5:30` but downloaded `5:09` (about `7%` short) likely means wrong speed, wrong edit, or bad rip.
- Discogs search should be efficient and probably cached

TECH NEEDS
- I want a neat API
