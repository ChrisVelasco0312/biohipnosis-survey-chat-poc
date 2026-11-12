{
  description = "Playwright e2e visual (headed) for the Biohipnosis survey chat POC";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_24
          pkgs.pnpm
          # Patchelf'd Chromium that works on NixOS. Playwright uses it via
          # CHROMIUM_EXECUTABLE_PATH (see playwright.config.ts) instead of the
          # prebuilt browser from ~/.cache/ms-playwright, which cannot load
          # against NixOS system libraries.
          pkgs.chromium
        ];

        shellHook = ''
          export CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
          export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
          echo "Playwright e2e visual — Biohipnosis POC"
          echo "  node $(node --version) | pnpm $(pnpm --version)"
          echo "  pnpm test                 # recorrido visual (ventana visible)"
          echo "  pnpm test:headless        # sin ventana (CI)"
          echo "  pnpm test:entrevista      # solo el flujo de entrevista"
          echo "  chromium: $CHROMIUM_EXECUTABLE_PATH"
        '';
      };
    };
}
