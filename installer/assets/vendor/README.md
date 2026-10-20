# Vendored compatibility dependency

`punycode.cjs` is the unmodified CommonJS implementation from `punycode` 2.3.1, already pinned in the extension pnpm lockfile. `punycode.LICENSE.txt` is its MIT license. The installer inlines both into the traced `cursor-retrieval` module so that no extra file needs to be registered in the official extension package.
