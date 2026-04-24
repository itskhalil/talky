{
  description = "Talky - Cross-platform desktop speech-to-text app";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        darwinBuildInputs = pkgs.lib.optionals pkgs.stdenv.isDarwin [
          pkgs.apple-sdk_14
          pkgs.libiconv
        ];

        linuxBuildInputs =
          with pkgs;
          pkgs.lib.optionals pkgs.stdenv.isLinux [
            alsa-lib
            at-spi2-atk
            cairo
            gdk-pixbuf
            glib
            gtk3
            libsoup_3
            openssl
            pango
            webkitgtk_4_1
            vulkan-headers
            vulkan-loader
            libayatana-appindicator
            libpulseaudio
          ];

        buildInputs =
          darwinBuildInputs
          ++ linuxBuildInputs
          ++ [
            pkgs.onnxruntime
          ];

        # Read values from tauri.conf.json so we don't duplicate them
        tauriConf = builtins.fromJSON (builtins.readFile ./src-tauri/tauri.conf.json);

        # Build the frontend with npm
        frontend = pkgs.buildNpmPackage {
          pname = "talky-frontend";
          version = tauriConf.version;
          src = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter =
              path: type:
              !(pkgs.lib.hasPrefix (toString ./src-tauri) path)
              && !(pkgs.lib.hasPrefix (toString ./.AI) path)
              && !(pkgs.lib.hasPrefix (toString ./tauri) path)
              && !(pkgs.lib.hasPrefix (toString ./nix) path)
              && (baseNameOf path != "flake.nix")
              && (baseNameOf path != "flake.lock");
          };
          npmDepsHash = "sha256-6o+a/D0UvrtOU19M92+HoCOd16G2nZ6frZcr46bnJqU=";
          # Skip npm post-install scripts that try to download native binaries
          # (onnxruntime-node via promptfoo -> @huggingface/transformers).
          # The frontend is pure React/TS and doesn't need any native modules.
          npm_config_ignore_scripts = "true";
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          buildPhase = ''
            npm run build
          '';
          installPhase = ''
            cp -r dist $out
          '';
        };

        # Build the Rust binary
        talky = pkgs.rustPlatform.buildRustPackage {
          stdenv = pkgs.clangStdenv;
          pname = "talky";
          version = tauriConf.version;

          src = ./src-tauri;

          cargoLock = {
            lockFile = ./src-tauri/Cargo.lock;
            outputHashes = {
              "vad-rs-0.1.5" = "sha256-Q9Dxq31npyUPY9wwi6OxqSJrEvFvG8/n0dbyT7XNcyI=";
            };
          };

          nativeBuildInputs = with pkgs; [
            pkg-config
            cmake
            libclang
            shaderc
            makeWrapper
          ];
          inherit buildInputs;

          LIBCLANG_PATH = "${pkgs.libclang.lib}/lib";

          doCheck = false;

          preBuild = ''
            ln -s ${frontend} ../dist
          '';

          buildFeatures = [ "tauri/custom-protocol" ];
          TALKY_LOCALES_DIR = "${./src/i18n/locales}";
          ORT_LIB_LOCATION = "${pkgs.onnxruntime}/lib";
          ORT_PREFER_DYNAMIC_LINK = "1";

          postInstall =
            ''
              mkdir -p $out/lib/Talky
              cp -r ${./src-tauri/resources} $out/lib/Talky/resources
            ''
            + pkgs.lib.optionalString pkgs.stdenv.isLinux ''
              install -Dm644 ${./src-tauri/talky.desktop} $out/share/applications/talky.desktop
              install -Dm644 ${./src-tauri/icons/128x128.png} $out/share/icons/hicolor/128x128/apps/talky.png
              install -Dm644 ${./src-tauri/icons/64x64.png} $out/share/icons/hicolor/64x64/apps/talky.png
              install -Dm644 ${./src-tauri/icons/32x32.png} $out/share/icons/hicolor/32x32/apps/talky.png
              install -Dm644 ${./src-tauri/icons/icon.png} $out/share/icons/hicolor/512x512/apps/talky.png
            '';

          postFixup =
            if pkgs.stdenv.isDarwin then
              ''
                install_name_tool -add_rpath "${pkgs.onnxruntime}/lib" $out/bin/talky
              ''
            else
              ''
                patchelf --add-rpath "${pkgs.onnxruntime}/lib:${pkgs.libayatana-appindicator}/lib" $out/bin/talky
                wrapProgram $out/bin/talky \
                  --set ALSA_PLUGIN_DIR "${pkgs.pipewire}/lib/alsa-lib"
              '';
        };

        # macOS .app bundle
        talkyApp = pkgs.stdenv.mkDerivation {
          pname = "talky-app";
          version = tauriConf.version;
          dontUnpack = true;

          installPhase = ''
            APP=$out/Applications/${tauriConf.productName}.app/Contents
            mkdir -p $APP/MacOS $APP/Resources/resources

            cp ${talky}/bin/talky $APP/MacOS/talky
            cp -r ${./src-tauri/resources}/* $APP/Resources/resources/
            cp ${./src-tauri/icons/icon.icns} $APP/Resources/icon.icns

            # Start with the repo's Info.plist (privacy descriptions) and add bundle metadata
            cp ${./src-tauri/Info.plist} $APP/Info.plist
            chmod u+w $APP/Info.plist

            ${pkgs.python3}/bin/python3 -c "
            import plistlib, sys
            with open(sys.argv[1], 'rb') as f:
                plist = plistlib.load(f)
            plist.update({
                'CFBundleName': '${tauriConf.productName}',
                'CFBundleDisplayName': '${tauriConf.productName}',
                'CFBundleIdentifier': '${tauriConf.identifier}',
                'CFBundleVersion': '${tauriConf.version}',
                'CFBundleShortVersionString': '${tauriConf.version}',
                'CFBundleExecutable': 'talky',
                'CFBundleIconFile': 'icon',
                'CFBundlePackageType': 'APPL',
                'LSMinimumSystemVersion': '14.0',
                'NSHighResolutionCapable': True,
            })
            with open(sys.argv[1], 'wb') as f:
                plistlib.dump(plist, f)
            " $APP/Info.plist
          '';
        };

      in
      {
        packages = {
          default = if pkgs.stdenv.isDarwin then talkyApp else talky;
          binary = talky;
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.isDarwin {
          app = talkyApp;
        };

        formatter = pkgs.nixfmt-tree;

        devShells.default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            pkg-config
            cmake
            cargo
            rustc
            rust-analyzer
            nodejs_20
            libclang
            shaderc
          ];
          inherit buildInputs;
          LIBCLANG_PATH = "${pkgs.libclang.lib}/lib";
        };
      }
    );
}
