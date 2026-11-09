// A named JSON import: the bundler keeps only `version`, not the rest of the
// root package.json (dependencies and scripts stay out of the bundle). There is
// no runtime fetch and no generated file to keep in sync. The root package.json
// is not a Nx project, hence the one-line lint exception.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { version } from '../../../../../package.json';

/** Version of the root package (e.g. `0.0.3`). */
export const APP_VERSION: string = version;
