/** Locates files shipped beside the plugin's `lib` directory, in a package or a source checkout. */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Absolute path of the `glab-agent` wrapper shipped with this package (`scripts/glab-agent`).
 * The module lives at `lib/` when packaged and at `src/` in a checkout, so `../scripts` resolves in both.
 */
export const packagedGlabAgent = (): string => join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'glab-agent')
