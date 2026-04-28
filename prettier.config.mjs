// Prettier-Config: bewusst von @iobroker/eslint-config-Default abweichend.
// homewizard wurde mit Spaces (2-wide) + DoubleQuotes geschrieben. Massen-
// Reformat wäre History-Murks ohne sachlichen Gewinn — der Override macht
// den faktischen Stil explizit. Pattern wie ioBroker.example/TypeScript
// (das ebenfalls overridet, mit anderen Werten).
import prettierConfig from '@iobroker/eslint-config/prettier.config.mjs';

export default {
  ...prettierConfig,
  useTabs: false,
  tabWidth: 2,
  singleQuote: false,
};
