#!/usr/bin/env bash
# Prépare le trousseau de signature macOS AVANT electron-builder.
#
# Pourquoi on ne laisse plus electron-builder le faire (constat du 2026-09-15) :
# quand CSC_LINK est posé, il crée un trousseau temporaire avec un mot de passe
# ALÉATOIRE, puis appelle
#   security set-key-partition-list ... -k <mot de passe du .p12> <trousseau>
# c'est-à-dire avec le MAUVAIS mot de passe (app-builder-lib, codeSign/macCodeSign.js,
# importCerts ; bug identique en 25.1.8 et en 26.15.3). Jusqu'à macOS 26.5,
# `security` ignorait ce mot de passe sur un trousseau déjà déverrouillé. Depuis
# l'image macOS 26.6 (Darwin 25.6.0), il le vérifie et refuse :
#   SecKeychainUnlock: The user name or passphrase you entered is not correct.
# Le job macOS du 2026-09-13 (v1.0.27) est mort là, alors que le même certificat,
# inchangé depuis le 2026-07-03, avait signé et notarisé la v1.0.26 le 2026-08-14.
# Ce n'était donc PAS un certificat invalide ni expiré : l'import du .p12, qui
# précède la commande fautive, avait réussi.
#
# Ici on crée le trousseau nous-mêmes, avec le bon mot de passe à chaque étape,
# et on le donne à electron-builder par CSC_KEYCHAIN (sans CSC_LINK, qui
# relancerait son chemin bogué).
set -euo pipefail

if [ -z "${MAC_CSC_LINK:-}" ]; then
  echo "MAC_CSC_LINK absent : le build macOS partira NON signé."
  exit 0
fi

KEYCHAIN="$RUNNER_TEMP/houla-signing.keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -base64 32)"
echo "::add-mask::$KEYCHAIN_PASSWORD"
CERT="$RUNNER_TEMP/houla-signing.p12"

# Même décodage qu'electron-builder (codeSign/codesign.js) : base64, préfixe
# `data:...;base64,` toléré, retours à la ligne ignorés par Buffer.
node -e '
  const lien = process.env.MAC_CSC_LINK;
  const prefixe = /data:.*;base64,/.exec(lien);
  require("fs").writeFileSync(process.argv[1], Buffer.from(lien.substring(prefixe ? prefixe[0].length : 0), "base64"));
' "$CERT"

security delete-keychain "$KEYCHAIN" 2>/dev/null || true
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
# 6 h sans reverrouillage : la notarisation peut durer longtemps.
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$CERT" -k "$KEYCHAIN" -P "$MAC_CSC_KEY_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/productbuild
rm -f "$CERT"
# LA commande qui échouait : cette fois avec le mot de passe du TROUSSEAU.
security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" > /dev/null

# Autorités intermédiaires Apple livrées avec electron-builder : son propre
# chemin les ajoute, le nôtre doit le faire aussi, sinon l'identité peut être
# jugée non fiable faute de chaîne complète.
ROOT_CERTS="$RUNNER_TEMP/electron-builder-root-certs.keychain"
cp node_modules/app-builder-lib/certs/root_certs.keychain "$ROOT_CERTS"

# Ajoute nos trousseaux à la liste de recherche sans retirer ceux du runner.
# shellcheck disable=SC2046
security list-keychains -d user -s "$KEYCHAIN" "$ROOT_CERTS" $(security list-keychains -d user | tr -d '"')

# Signal DISCRIMINANT : `find-identity -v` ne liste que les identités VALIDES.
# Un certificat réellement expiré ou révoqué échoue ICI, avec un message clair,
# au lieu de mourir plus loin dans electron-builder.
if ! security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "Developer ID Application"; then
  echo "::error::Aucune identité « Developer ID Application » VALIDE dans MAC_CSC_LINK (certificat expiré, révoqué, ou mauvais type)."
  security find-identity -p codesigning "$KEYCHAIN" || true
  exit 1
fi
echo "Identité de signature valide :"
security find-identity -v -p codesigning "$KEYCHAIN" | grep "Developer ID Application"
security find-certificate -c "Developer ID Application" -p "$KEYCHAIN" | openssl x509 -noout -enddate

echo "CSC_KEYCHAIN=$KEYCHAIN" >> "$GITHUB_ENV"
