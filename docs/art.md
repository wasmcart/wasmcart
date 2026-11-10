# Cart art

A `.wasc` can carry its own pictures, so a launcher can show a cart properly
without a scraper, an online database or a separate download: its icon on a
home screen, its box art in a grid, key art behind its details, its
screenshots. SPEC.md, "Manifest", field `art`, is the definition; this page
is how to make the pictures and where hosts put them.

Everything here is optional. A cart without art runs everywhere it ran
before, and a host that knows nothing of `art` runs a cart that has it: hosts
ignore manifest fields they do not know.

## What to make

| key | what it is | shape | at least | format |
|---|---|---|---|---|
| `icon` | the app icon | square | 256 x 256, 512 recommended | PNG, may be transparent |
| `cover` | box art: a picture of the game with its name on it | portrait 2:3 | 600 x 900 | JPEG or PNG |
| `background` | key art with no text at all | 16:9 | 1920 x 1080 | JPEG or PNG |
| `logo` | the game's name as the game draws it | wider than tall | 1280 wide or 720 tall | PNG with transparency |
| `title` | the title screen as the game shows it | the cart's aspect | the cart's resolution | PNG |
| `screenshots` | play as the game shows it, each with a label | the cart's aspect | the cart's resolution | PNG, or JPEG for photographic scenes |

- **Icon.** Keep the subject inside the centred circle of 80% of the width.
  Phones and some launchers mask icons to a circle or a rounded square, and
  anything outside that circle can be cut off. No text: at 48 pixels it cannot
  be read.
- **Cover.** The one picture that has to say what the game is at a glance in a
  grid of others. The name belongs on it, large.
- **Background and logo** are a pair. A launcher draws the background full
  screen and the logo over it, so the background needs a calm area where the
  logo can sit and no text of its own, and the logo needs a transparent
  background (a launcher may also draw it on its own, over its own colours).
- **Title** is the title screen exactly as the game shows it.
- **Screenshots.** Real play, at the cart's own resolution, never mock-ups. The
  first is the one shown when there is room for only one, so make it the most
  telling. Each `label` is a short description ("Three ships trading broadsides
  at dusk"): screen readers read it, and a launcher may show it as a caption.
  Three to six is plenty.

Sizes above the minimum are fine and look better on large screens; a launcher
scales down. There is no size limit, but a 4K cover is wasted: about 1200 x
1800 for a cover and 3840 x 2160 for a background is the most any launcher
shows today.

## Packing

Put the pictures in a directory, named for their key, and pass it to
`wasmcart-pack --art`:

```
art/
  icon.png
  cover.jpg
  background.jpg
  logo.png
  title.png
  screenshot-1.png
  screenshot-2.png
```

```bash
npx wasmcart-pack --wasm cart.wasm --assets assets/ --art art/ -o game.wasc \
  --description "Sail, trade and fight across a sunlit archipelago." --author "Me"
```

Screenshots are taken in name order (`screenshot-2` before `screenshot-10`).
To name files freely or give screenshots labels, add an `art.json` to the
directory in the manifest's own shape, its paths relative to the directory:

```json
{
  "cover": "box-art-final.jpg",
  "logo": "name.png",
  "screenshots": [
    { "path": "harbour.png", "label": "Trading in a busy harbour" },
    { "path": "battle.png", "label": "Three ships trading broadsides at dusk" }
  ]
}
```

The pack tool puts the files in the archive under `art/` (outside the asset
prefix, so the cart never sees them) and writes the manifest's `art`. A file
that is not a PNG or JPEG stops the pack: it can only be a mistake. A picture
of the wrong shape or too small only warns, as does a logo with no
transparency.

A `--source` dev directory carries its art in its own manifest; the pack tool
keeps it and warns about any file it names that is missing or wrong.

## For hosts

- Read `manifest.json` and the files `art` names straight from the archive (a
  `.wasc` is a zip). There is no need to instantiate the cart, and a launcher
  should not: a library of hundreds of carts shows its covers without running
  any of them.
- Never refuse, delay or change a cart over its art. A missing, unreadable or
  odd-sized picture means falling back to what the host shows without one.
- `src/cartArt.js` has the checks the pack tool uses: `imageInfo(bytes)` reads
  a PNG's or JPEG's size, and `describeArtProblems(art, read)` lists what is
  wrong with a manifest's art.

Frontends that keep art in folders by game name take these keys:

| key | libretro thumbnails | ES-DE media |
|---|---|---|
| `cover` | `Named_Boxarts` | `covers` |
| first of `screenshots` | `Named_Snaps` | `screenshots` |
| `title` | `Named_Titles` | `titlescreens` |
| `logo` | | `marquees` |
| `background` | | `fanart` |
| `icon` | | |

`wasmcart art <carts> --esde <dir>` (or `--libretro <dir>`) copies them there
(README, "wasmcart art"). The manifest's `title` (the game's name as people
read it) is not art: a frontend shows it from its own game list.

## Where this comes from

The same split appears in most packaged games. Handheld and console formats
carry the identity art in the package (a PSP's `ICON0.PNG` and background, a
Vita's `sce_sys` pictures, a Switch title's per-language icon, a Playdate
game's card and icon, a TIC-80 cart's cover), while stores keep their own
larger sets beside it (a library's capsule, hero and logo; a web app
manifest's icons and labelled screenshots). Frontends that cannot find art in
the package scrape it by name, which fails for homebrew and for new games no
database knows yet: the reason a cart carries its own.
