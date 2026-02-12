# Date Library Evaluation: Day.js vs Alternatives

## Current State

The bot uses **day.js v1.11.19** with 4 plugins (UTC, Timezone, AdvancedFormat, RelativeTime) across 10 source files. Timezone handling is the core use case — the bot performs per-user daily resets at each user's local midnight, groups voice sessions by calendar day in the user's timezone, and formats timestamps in user-local time.

### How Day.js Is Used

| Feature | Methods | Key Files |
|---|---|---|
| Timezone conversion | `.tz(userTimezone)` | centralResetService.ts, timezone.ts, user.ts, submit.ts |
| Date arithmetic | `.startOf()`, `.endOf()`, `.subtract()`, `.diff()` | user.ts, user_id.ts, db.ts, submit.ts |
| Date comparison | `.isSame()`, `.isBefore()`, `.isAfter()` | centralResetService.ts, user.ts |
| Formatting | `.format()` with 8+ patterns | All files |
| DB conversion | `.toDate()` | All DB operations |

The `relativeTime` plugin is imported but never used — it can be removed.

---

## Day.js: Known Problems Relevant to This Project

Day.js's timezone plugin has **well-documented DST bugs** with 900+ open issues and 200+ open PRs on GitHub. Maintenance is slow and infrequent — the long-promised 2.0 alpha has seen no progress in 3+ years.

### Bugs that could affect this bot

1. **Wrong offset during DST** ([#1260](https://github.com/iamkun/dayjs/issues/1260)): Timezone conversion produces incorrect results when DST is in effect. A summer date may get the winter offset if the code runs in winter, or vice versa. This directly impacts the daily reset logic in `centralResetService.ts`.

2. **`.tz()` is not idempotent** ([#1805](https://github.com/iamkun/dayjs/issues/1805)): Calling `.tz('America/Chicago')` repeatedly on the same object shifts the time by one hour with each call during DST. Any defensive double-call is actively harmful.

3. **`add()` incorrect across DST** ([#2624](https://github.com/iamkun/dayjs/issues/2624)): Adding days assumes 24-hour days, which is wrong across DST transitions. Affects session grouping and weekly aggregation in `user.ts`.

4. **`setDefault` timezone ignored during parsing** ([#2928](https://github.com/iamkun/dayjs/issues/2928)): Despite `dayjs.tz.setDefault('UTC')` in `src/index.ts`, parsing may not respect it.

### Why it hasn't caused visible issues (yet)

- The bot runs server-side in UTC, so the server clock itself never hits DST transitions
- Most users likely use UTC or non-DST timezones, reducing exposure
- The hourly reset cron provides a "retry" window — if a reset is slightly miscalculated due to DST, the next hourly run will likely catch it
- Voice session timestamps come from the system clock (UTC), with timezone conversion only at display time

These are mitigating factors, not guarantees. Users in DST-observing timezones (US, EU, Australia) could experience off-by-one-hour errors in resets, session grouping, or submission linking during DST transitions.

---

## Alternatives Evaluated

### Moment.js — Not recommended

Deprecated since September 2020. In maintenance-only mode. No new features, mutable API, not tree-shakable, ~16 KB gzipped. The Moment.js team themselves recommend Luxon, Day.js, date-fns, or Temporal as replacements.

### Temporal API — Not ready yet

Stage 3 TC39 proposal. Shipped in Firefox 139 (May 2025) and Chrome 144 (January 2026). Expected to reach Stage 4 at the March 2026 TC39 plenary. However:

- **Not yet available in Node.js** — this is a blocker for a server-side bot
- Safari support is behind a flag
- Polyfills exist (`@js-temporal/polyfill`, `temporal-polyfill`) but add 20-30 KB and risk spec drift

Temporal is the correct long-term answer but is not production-ready for Node.js server applications today.

### date-fns v4 with @date-fns/tz — Viable but less mature

date-fns v4 introduced first-class timezone support via `TZDate` class (~916 bytes). Functional style, tree-shakable.

Pros:
- Small individual function imports
- `TZDate` class handles timezone-aware calculations correctly
- Active maintenance

Cons:
- `@date-fns/tz` is relatively new; fewer production miles for timezone-heavy work
- Functional API requires passing timezone context to every function call — more verbose for this codebase's pattern of chained operations
- Open issues with `Intl` compatibility on some platforms

### Luxon — Recommended

Built by a Moment.js maintainer (Isaac Cambron). ~23 KB gzipped (bundle size is irrelevant for a Node.js server application).

Pros:
- **Built-in timezone support** — no plugins, no configuration step
- **DST-aware arithmetic**: `dt.plus({ days: 1 })` correctly handles DST transitions (unlike Day.js's `add(1, 'day')`)
- **Ambiguous/invalid time detection**: Can detect and resolve fall-back (ambiguous) and spring-forward (gap) times
- **Actively maintained** with regular releases
- **Immutable and chainable** — similar ergonomics to Day.js
- **Built-in Intl-based i18n** — no locale plugins needed
- OOP API means migration from Day.js is relatively straightforward (both use method chaining)

Cons:
- Larger bundle size (~23 KB gzipped vs ~7 KB for Day.js with plugins) — irrelevant for server-side
- Different API surface — migration requires touching all 10 files
- Learning curve for developers familiar with Moment/Day.js API

---

## Recommendation

**Switch to Luxon.**

### Rationale

1. **Correctness over size**: This is a server-side Node.js application. Bundle size does not matter. Timezone correctness does — resets, streaks, and session tracking all depend on it.

2. **DST safety**: Day.js's timezone plugin has fundamental architectural limitations that cause incorrect behavior during DST transitions. Luxon handles DST correctly by design.

3. **Maintenance risk**: Day.js has 900+ open issues, infrequent releases, and an abandoned 2.0 roadmap. Luxon is actively maintained by a core Moment.js contributor.

4. **Migration scope**: 10 files, mostly mechanical changes. The OOP/chaining style is similar between Day.js and Luxon.

5. **Future path**: When Temporal lands in Node.js, migrating from Luxon to Temporal will be straightforward since both use similar timezone-aware date concepts. Day.js's plugin-based approach is further from Temporal's model.

### Migration Effort Estimate

The migration touches 10 files with these categories of changes:

| Change Type | Count | Complexity |
|---|---|---|
| Import statements | 10 files | Trivial |
| Plugin setup removal | 2 files (index.ts, analytics-dev.ts) | Trivial |
| `.tz(timezone)` → `.setZone(timezone)` | ~20 call sites | Mechanical |
| `.format(pattern)` → `.toFormat(pattern)` | ~15 call sites | Mechanical (format tokens differ slightly) |
| `.startOf()` / `.endOf()` | ~10 call sites | Direct equivalent exists |
| `.isSame()` / `.isBefore()` | ~5 call sites | `.hasSame()` / comparison operators |
| `.diff()` | ~5 call sites | `.diff()` exists but returns Duration |
| `.toDate()` | ~5 call sites | `.toJSDate()` |
| `dayjs(date)` construction | ~15 call sites | `DateTime.fromJSDate(date)` |

### API Mapping Reference

| Day.js | Luxon |
|---|---|
| `dayjs()` | `DateTime.now()` |
| `dayjs(date)` | `DateTime.fromJSDate(date)` |
| `dayjs().tz(tz)` | `DateTime.now().setZone(tz)` |
| `dayjs(date).tz(tz)` | `DateTime.fromJSDate(date).setZone(tz)` |
| `.format('YYYY-MM-DD')` | `.toFormat('yyyy-MM-dd')` |
| `.format('HH:mm')` | `.toFormat('HH:mm')` |
| `.format('h:mm A')` | `.toFormat('h:mm a')` |
| `.format('MMM D')` | `.toFormat('MMM d')` |
| `.format('z')` | `.toFormat('ZZZZ')` or `.offsetNameShort` |
| `.startOf('day')` | `.startOf('day')` |
| `.endOf('day')` | `.endOf('day')` |
| `.startOf('week')` | `.startOf('week')` |
| `.startOf('month')` | `.startOf('month')` |
| `.subtract(1, 'month')` | `.minus({ months: 1 })` |
| `.add(1, 'day')` | `.plus({ days: 1 })` |
| `.diff(other, 'day')` | `.diff(other, 'days').days` |
| `.isSame(other, 'day')` | `.hasSame(other, 'day')` |
| `.isBefore(other)` | `dt < other` (or `.valueOf() < other.valueOf()`) |
| `.isAfter(other)` | `dt > other` |
| `.toDate()` | `.toJSDate()` |
| `.date()` | `.day` |
| `.daysInMonth()` | `.daysInMonth` |

### Format Token Differences

| Meaning | Day.js | Luxon |
|---|---|---|
| 4-digit year | `YYYY` | `yyyy` |
| 2-digit month | `MM` | `MM` |
| 2-digit day | `DD` | `dd` |
| Day of month (no pad) | `D` | `d` |
| 24-hour | `HH` | `HH` |
| 12-hour | `h` | `h` |
| Minutes | `mm` | `mm` |
| Seconds | `ss` | `ss` |
| AM/PM | `A` | `a` |
| Month abbrev | `MMM` | `MMM` |
| Month full | `MMMM` | `MMMM` |
| Day name full | `dddd` | `EEEE` |
| Timezone abbrev | `z` | `ZZZZ` |
| Literal text | `[text]` | `'text'` |
