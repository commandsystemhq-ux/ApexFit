# Exercise catalog source

`free-exercise-db-apexfit.json` is transformed from [yuhonas/free-exercise-db](https://github.com/yuhonas/free-exercise-db), pinned to commit [`f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5`](https://github.com/yuhonas/free-exercise-db/commit/f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5).

The upstream repository identifies the dataset as public domain under the [Unlicense](https://unlicense.org/); the license text is included in `LICENSE-FREE-EXERCISE-DB.md`. The prepared file maps source categories, equipment, and muscle names to ApexFit's supported filters, and uses the source's first image as a thumbnail. The upstream dataset contains 876 exercise records and no demo videos, so video URLs are left empty rather than fabricated.

Regenerate the normalized file with `npm run prepare:exercise-catalog`.

The prepared file also lists `image_frames` (the upstream photos of the start and end of each movement), which the app loops as a light animation. Videos and GIFs are not part of the dataset and are never invented: to add your own licensed clips create `data/exercise-media.json` as `{ "<slug>": { "animation_url": "https://.../clip.mp4" } }` (HTTPS `.mp4`, `.webm`, `.gif` or `.webp`, at most 2 MB each) and run the import.
