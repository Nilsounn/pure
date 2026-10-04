# Publier une nouvelle version de Pure

Pure vérifie les GitHub Releases de `Nilsounn/pure` au lancement (puis toutes les 4 h). Quand une Release plus récente existe, il télécharge `PureSetup.exe`, le vérifie, et propose « Redémarrer » : plus besoin de repasser par l'installateur à la main.

## Pour chaque version

1. Change la version dans `package.json` (ex. `1.14.1`). C'est ce numéro que Pure compare à celui de la Release.
2. Construis l'application :
   `npm run package-win`
3. Construis l'installateur avec le même numéro :
   `makensis /DVERSION=1.14.1 installer.nsi`   → crée `dist\PureSetup.exe`
4. Publie une Release :
   - Tag **`v1.14.1`** (le « v » est facultatif, mais le numéro doit être plus grand que le précédent).
   - Pièce jointe : **`PureSetup.exe`** (ce nom exact).
   - Avec GitHub CLI : `gh release create v1.14.1 dist/PureSetup.exe --title "Pure 1.14.1" --notes "Ce qui change"`

## À savoir

- Le dépôt doit rester **public** (Pure interroge l'API GitHub sans identifiant).
- Une Release en « brouillon » ou « pré-version » est ignorée.
- Protège ton compte GitHub avec la double authentification : quiconque peut publier une Release peut mettre à jour les Pure installés.
- La première version contenant l'updater (1.14.0) doit être installée à la main. Les suivantes se mettront à jour toutes seules.
- Test rapide : installe 1.14.0, publie 1.14.1, relance Pure : le bandeau « Pure 1.14.1 est prêt » apparaît après quelques secondes. Réglages > Mises à jour permet aussi de lancer la vérification à la main.
