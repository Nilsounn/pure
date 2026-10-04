# Mettre à jour Pure (méthode simple)

Tu n'as rien à construire ni à publier toi-même : GitHub le fait.

## Chaque fois que tu reçois de nouveaux fichiers
1. Va sur https://github.com/Nilsounn/pure
2. **Add file > Upload files**
3. Glisse tous les fichiers du zip décompressé (dossiers `build` et `.github` compris), puis **Commit changes**.
4. Attends 5 à 10 minutes (onglet **Actions** : une pastille verte = c'est publié).

C'est tout. Au prochain lancement, les Pure installés proposent « Redémarrer » pour passer à la nouvelle version.

## À savoir
- Les versions s'appellent 26.1, 26.2, 26.3… (26 = l'année, puis le numéro de la mise à jour). Dans `package.json` elles s'écrivent `26.1.0`, `26.2.0`… : rien à y changer à la main, je le fais.
- Rien ne se publie si ce numéro n'a pas augmenté.
- Pastille rouge dans Actions : ouvre-la, copie le message d'erreur et envoie-le-moi.
- Garde le dépôt **public** et active la double authentification sur ton compte GitHub.
- La première fois, installe Pure à la main (PureSetup-26.1.exe) : les versions suivantes se mettront à jour toutes seules.
- Réglages > Mises à jour dans Pure permet de lancer la vérification à la main.
