# Tutoriel : déployer uniquement les nouveautés (site des widgets sous `/plugin/`)

Ce tutoriel décrit, pas à pas, comment mettre en service le site des widgets et des bibliothèques JS **sans réinstaller** l'existant (Grist, RPX, Flask, Keycloak, bases de données). Il s'appuie sur le dépôt `optimis-evolution_ansible-widgets.zip` et sur votre pipeline GitLab.

> Les schémas sont en [Mermaid](https://mermaid.js.org/) : ils s'affichent dans GitLab, VS Code (extension Markdown Mermaid) et la plupart des visionneuses Markdown.

---

## Sommaire

1. [Le principe : ne déployer que ce qui est nouveau](#1-le-principe--ne-déployer-que-ce-qui-est-nouveau)
2. [Inventaire des nouveautés et impact sur l'existant](#2-inventaire-des-nouveautés-et-impact-sur-lexistant)
3. [Vue d'ensemble du déroulé](#3-vue-densemble-du-déroulé)
4. [Prérequis](#4-prérequis)
5. [Étape 0 : préparer le dépôt](#5-étape-0--préparer-le-dépôt)
6. [Étape 1 : Terraform (règle de sécurité)](#6-étape-1--terraform-règle-de-sécurité)
7. [Étape 2 : le site des widgets (`widgets.yml`)](#7-étape-2--le-site-des-widgets-widgetsyml)
8. [Étape 3 : le RPX (`rpx.yml`)](#8-étape-3--le-rpx-rpxyml)
9. [Étape 4 : Grist (`grist.yml`)](#9-étape-4--grist-gristyml)
10. [Étape 5 : validation de bout en bout](#10-étape-5--validation-de-bout-en-bout)
11. [Après la mise en service](#11-après-la-mise-en-service)
12. [Retour arrière](#12-retour-arrière)
13. [Variante : lancer depuis un poste ou en mode simulation](#13-variante--lancer-depuis-un-poste-ou-en-mode-simulation)
14. [Dépannage](#14-dépannage)
15. [Fiche récapitulative](#15-fiche-récapitulative)

---

## 1. Le principe : ne déployer que ce qui est nouveau

Votre pipeline lance `ansible-playbook playbooks/<PLAYBOOK> --limit "<TARGET>"`. Deux variables suffisent donc à cibler précisément :

| Variable | Rôle | Pour ce déploiement |
|---|---|---|
| `PLAYBOOK` | le playbook à exécuter | `widgets.yml`, puis `rpx.yml`, puis `grist.yml` |
| `TARGET` | restreint aux serveurs ou groupes nommés (`--limit`) | `flask_python`, puis `rpx`, puis `grist` |

**Règle d'or : ne jamais lancer `deploy_all.yml`** pour cette évolution. Il rejoue tous les rôles sur tous les serveurs : il reconfigurerait Keycloak, les bases, Redis, etc., pour rien.

Le choix des playbooks évite aussi des effets de bord :

| Playbook | Ce qu'il exécute | Pourquoi ce choix |
|---|---|---|
| `widgets.yml` | uniquement le rôle `widgets_site` sur `flask_python` | `flask.yml` rejouerait aussi `psg` (PostgreSQL) et `flask_python` (l'API Flask) |
| `rpx.yml` | le rôle `rpx` sur `rpx` | seul playbook qui touche Apache |
| `grist.yml` | `psg` sur `bdd_grist` puis `grist` sur `grist` | avec `TARGET=grist`, la première partie (base de données) est sautée |

```mermaid
flowchart LR
  subgraph AVANT["Avant"]
    direction TB
    N1["Navigateur"] --> R1["RPX Apache"]
    R1 -->|"/ et /sso/"| G1["Grist :8484"]
    G1 -.->|"liste des widgets"| GH1["Internet\n(github.io, CDN)"]
  end
  subgraph APRES["Après"]
    direction TB
    N2["Navigateur"] --> R2["RPX Apache"]
    R2 -->|"/ et /sso/"| G2["Grist :8484"]
    R2 -->|"/plugin/ (nouveau)"| W2["nginx :8080\nsur opt-flask-python-1 (nouveau)"]
    G2 -->|"GRIST_WIDGET_LIST_URL"| R2
    SY["widgets_sync.py\n(nouveau)"] -->|"proxy authentifiant"| GH2["Internet"]
    SY --> W2
  end
  AVANT ~~~ APRES
```

---

## 2. Inventaire des nouveautés et impact sur l'existant

| # | Nouveauté | Fichier(s) | Déployé par | Effet sur le service existant |
|---|---|---|---|---|
| 1 | Règle de sécurité : le RPX joint le port 8080 du serveur Flask | `terraform/network.tf` | job `apply_plan` puis `apply` | aucun redémarrage ; ajoute une règle au groupe de sécurité |
| 2 | Conteneur nginx, listes JSON, script de synchronisation, minuteur | `roles/widgets_site/`, `playbooks/widgets.yml`, variables | `widgets.yml` | nouveau conteneur dans `/opt/widgets-site` ; l'API Flask n'est pas touchée |
| 3 | Chemin `/plugin/` du RPX | `roles/rpx/templates/app.conf.j2` | `rpx.yml` | `reload` gracieux d'Apache : aucune coupure |
| 4 | Nouvelle adresse de la liste des widgets | `group_vars/grist.yml` | `grist.yml` | **le conteneur Grist est recréé** : coupure de quelques secondes |
| 5 | Playbook `widgets.yml` proposé dans la CI | `.gitlab-ci.yml` | (fait partie du commit) | aucun |

```mermaid
flowchart TD
  T["1. Terraform\nrègle 8080 : RPX vers Flask"] --> W["2. widgets.yml\nconteneur + téléchargement"]
  W --> R["3. rpx.yml\nProxyPass /plugin/"]
  R --> G["4. grist.yml\nGRIST_WIDGET_LIST_URL"]
  G --> V["5. Validation"]
  T -.->|"sans elle,\nle RPX n'atteint pas le port 8080"| R
  W -.->|"avant le RPX :\nle manifest existe déjà"| R
  R -.->|"avant Grist :\nl'adresse répond déjà"| G
```

**Ce qui n'est pas touché** : Keycloak, Redis, les bases PostgreSQL, l'API Flask, les données de Grist, les certificats.

Deux points à surveiller, car un rôle rejoue **tout son contenu**, pas seulement votre nouveauté :

- `rpx.yml` régénère aussi les modèles Apache de `grist.conf` **et** `keycloak.conf`. Si un fichier du rôle ou une variable a changé depuis le dernier déploiement, ce changement partira aussi (voir §5.4).
- `grist.yml` réécrit le `docker-compose.yml` de Grist et configure le proxy de Docker. Si `http_proxy` ou `no_proxy` ont changé depuis le dernier déploiement, **le service Docker est redémarré** (et donc tous ses conteneurs). Vous ne les avez pas modifiés ici : c'est un point de contrôle, pas un risque attendu.

---

## 3. Vue d'ensemble du déroulé

```mermaid
sequenceDiagram
  autonumber
  actor VOUS as Vous
  participant GL as GitLab (pipeline)
  participant RUN as Runner Ansible
  participant FL as opt-flask-python-1
  participant RP as RPX (Apache)
  participant GR as opt-grist-1 (Grist)

  VOUS->>GL: Merge request (code des nouveautés)
  VOUS->>GL: Pipeline : apply_plan, lecture du plan, apply
  Note over GL: Terraform ajoute la règle 8080
  VOUS->>GL: Pipeline : PLAYBOOK=widgets.yml, TARGET=flask_python
  GL->>RUN: ansible-playbook widgets.yml --limit flask_python
  RUN->>FL: conteneur nginx, téléchargement, minuteur
  VOUS->>FL: Contrôle : curl du manifest
  VOUS->>GL: Pipeline : PLAYBOOK=rpx.yml, TARGET=rpx
  RUN->>RP: modèle Apache puis reload gracieux
  VOUS->>RP: Contrôle : /plugin/manifest.json répond
  VOUS->>GL: Pipeline : PLAYBOOK=grist.yml, TARGET=grist
  RUN->>GR: nouvelle liste de widgets, conteneur recréé
  VOUS->>GR: Contrôle : les widgets apparaissent
```

À chaque étape, **on contrôle avant de passer à la suivante** : un problème détecté tôt reste cantonné à la nouveauté.

---

## 4. Prérequis

| Prérequis | Vérification |
|---|---|
| Accès au projet GitLab et droit de lancer des pipelines manuels | le bouton « Nouveau pipeline » est disponible |
| Accès SSH aux serveurs `opt-flask-python-1`, au RPX et à `opt-grist-1` | pour les contrôles des étapes 2 à 4 |
| Image nginx disponible dans l'Artifactory | voir 4.1 |
| Identifiants du **proxy authentifiant** | compte et mot de passe prêts |
| Le serveur Flask atteint Internet par ce proxy | voir 4.2 |

### 4.1 Vérifier l'image nginx

Sur `opt-flask-python-1` :

```bash
sudo docker pull artifactory.containers.forge-dc.cloudmi.minint.fr/remote-dockerhub/library/nginx:1.27-alpine
```

- Si l'image est récupérée : le chemin est le bon, rien à changer.
- Si le chemin est introuvable : trouvez le bon chemin dans l'Artifactory (comme pour l'image de Grist) et corrigez `widgets_image` dans `ansible/inventories/dev/group_vars/flask_python.yml`.
- Si la connexion échoue : le démon Docker de ce serveur doit joindre l'Artifactory **sans** proxy (comme sur le serveur Grist) ; faites vérifier sa configuration.

### 4.2 Vérifier le proxy authentifié depuis le serveur Flask

Saisissez le mot de passe sans l'écrire dans l'historique :

```bash
read -r -p "Compte du proxy : " PXU
read -r -s -p "Mot de passe : " PXP; echo
curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
  -x "http://${PXU}:${PXP}@proxydc-sil.dtct.minint.fr:3128" \
  https://github.com/gristlabs/grist-widget/releases/download/latest/manifest.json
unset PXU PXP
```

| Résultat | Signification |
|---|---|
| `HTTP 200` ou `302` | le proxy et les identifiants fonctionnent |
| `HTTP 407` | identifiants refusés |
| erreur de connexion ou de certificat | port bloqué, ou proxy qui inspecte le TLS (voir `widgets_ca_bundle` au §14) |

---

## 5. Étape 0 : préparer le dépôt

### 5.1 Créer une branche et y mettre le code

```mermaid
gitGraph
  commit id: "état actuellement déployé"
  branch feature/widgets-site
  checkout feature/widgets-site
  commit id: "role widgets_site"
  commit id: "rpx, grist, terraform, CI"
  commit id: "identifiants chiffrés"
  checkout main
  merge feature/widgets-site tag: "dev-widgets-v1"
```

1. Récupérez le dépôt, créez la branche : `git checkout -b feature/widgets-site`.
2. Dézippez `optimis-evolution_ansible-widgets.zip` **par-dessus** votre dépôt : les fichiers modifiés sont remplacés, les nouveaux ajoutés, les autres inchangés.
3. Contrôlez ce qui change : `git status` puis `git diff --stat`. Vous devez retrouver uniquement les fichiers listés au §2 (et rien d'autre).

### 5.2 Les quatre réglages à renseigner

| Réglage | Fichier | À faire |
|---|---|---|
| Image nginx | `ansible/inventories/dev/group_vars/flask_python.yml` (`widgets_image`) | corriger si le chemin du §4.1 diffère |
| Nom du serveur Flask | `group_vars/rpx.yml` (`widgets_internal_dns`) | `opt-flask-python-1` ; le même nom que `flask_internal_dns` de `arp.yml` |
| Listes à télécharger | `roles/widgets_site/files/widgets.json` et `bibjs.json` | la liste fournie reprend le manifest officiel de Grist ; ajoutez vos hôtes et bibliothèques |
| Identifiants du proxy | `group_vars/flask_python/vault.yml` (chiffré) | voir 5.3 |

### 5.3 Chiffrer les identifiants du proxy

Les identifiants ne doivent jamais apparaître en clair dans le dépôt.

```bash
cd ansible/inventories/dev/group_vars/flask_python
cp vault.yml.example vault.yml
# éditer vault.yml : renseigner widgets_proxy_user et widgets_proxy_password
ansible-vault encrypt vault.yml
```

Ansible vous demande de choisir un mot de passe de coffre. **Notez-le dans votre gestionnaire de mots de passe** : sans lui, le fichier est illisible.

Puis dans GitLab, pour que le pipeline puisse déchiffrer :

1. **Paramètres du projet, CI/CD, Variables, Ajouter une variable.**
2. Type : **Fichier** ; clé : `ANSIBLE_VAULT_PASSWORD_FILE` ; valeur : le mot de passe du coffre.
3. Cochez « Protégée » si la branche utilisée pour déployer l'est aussi.

GitLab place alors la valeur dans un fichier temporaire et `ANSIBLE_VAULT_PASSWORD_FILE` contient son chemin : Ansible le lit tout seul.

Vous pouvez commiter `vault.yml` (il est chiffré) mais **jamais** le mot de passe du coffre.

### 5.4 Contrôler qu'aucun autre changement ne se glisse dans le déploiement

Chaque rôle rejoue tout son contenu. Listez ce qui a changé depuis le dernier déploiement (remplacez `<dernier-commit-déployé>` par le commit ou l'étiquette de la dernière mise en service) :

```bash
git diff --stat <dernier-commit-déployé> HEAD -- \
  ansible/roles/rpx ansible/roles/grist ansible/roles/widgets_site \
  ansible/inventories/dev/group_vars terraform
```

Vous ne devez voir **que** les fichiers du §2. S'il y a autre chose (un changement ancien jamais déployé, par exemple), décidez avec son auteur : soit vous l'assumez, soit vous le retirez de la branche.

### 5.5 Tests locaux (avant le pipeline)

Test du script de téléchargement (aucun accès Internet nécessaire : il utilise de faux serveurs) :

```bash
python3 ansible/roles/widgets_site/tests/test_widgets_sync.py
```

Attendu : `Ran 6 tests ... OK`.

Contrôle de syntaxe des playbooks (facultatif, si Ansible est installé sur votre poste) :

```bash
cd ansible
ansible-playbook --syntax-check -i localhost, playbooks/widgets.yml
ansible-playbook --syntax-check -i localhost, playbooks/rpx.yml
```

### 5.6 Commit et merge request

```bash
git add -A
git commit -m "Site des widgets Grist sous /plugin/ : rôle widgets_site, RPX, Grist, Terraform"
git push -u origin feature/widgets-site
```

Ouvrez la merge request, faites-la relire (en particulier `terraform/network.tf` et `app.conf.j2`), puis fusionnez-la. **Attention** : la fusion ne déploie rien ; le pipeline ne fait rien tant que vous ne lancez pas les jobs manuels.

---

## 6. Étape 1 : Terraform (règle de sécurité)

**But** : autoriser le RPX à joindre le port 8080 du serveur Flask. Sans cette règle, tout appel à `/plugin/` expire.

1. **Build, Pipelines** (ou **CI/CD, Pipelines** selon la version de GitLab), **Nouveau pipeline**.
2. Branche : celle qui porte le code (la branche principale après la fusion). Variable `ENVIRONMENT` : `dev`.
3. Une fois le pipeline créé, lancez le job manuel **`apply_plan`** (bouton lecture).
4. **Lisez le journal du job**, tout en bas :

   | Ce que vous voyez | Décision |
   |---|---|
   | `Plan: 1 to add, 0 to change, 0 to destroy.` | conforme, continuez |
   | une ligne `openstack_networking_secgroup_rule_v2 ... will be created` sur le groupe du serveur Flask | conforme |
   | `to destroy` ou `must be replaced` sur une **instance** | **ARRÊTEZ-VOUS** : ne lancez pas `apply` ; le plan n'est pas celui attendu |
   | d'autres règles créées ou détruites | **ARRÊTEZ-VOUS** et comprenez pourquoi avant de continuer (voir l'encadré) |

   > Le module réseau est chargé depuis un dépôt GitLab (`terraform init -upgrade` dans la CI). Si ce module a évolué depuis le dernier déploiement, le plan peut montrer des changements sans lien avec votre règle : c'est la raison de cette lecture attentive.

5. Si le plan est conforme, lancez le job manuel **`apply`** (il dépend de `apply_plan`).
6. Attendu à la fin : `Apply complete! Resources: 1 added, 0 changed, 0 destroyed.`

**Contrôle** : dans l'interface OpenStack (Réseau, Groupes de sécurité), le groupe du serveur Flask contient maintenant une règle d'entrée TCP 8080 dont la source est le groupe du RPX. Le contrôle fonctionnel viendra à l'étape 3 (`curl` depuis le RPX).

---

## 7. Étape 2 : le site des widgets (`widgets.yml`)

### 7.1 Lancer le pipeline

1. **Nouveau pipeline**, variables :

   | Variable | Valeur |
   |---|---|
   | `ENVIRONMENT` | `dev` |
   | `PLAYBOOK` | `widgets.yml` |
   | `TARGET` | `flask_python` |

2. Lancez le job manuel **`Ansible Playbook S2R1`**.

### 7.2 Ce que fait le rôle, dans l'ordre

```mermaid
flowchart TD
  A["Dossiers : conf, www, www/widget,\nwww/bibjs, sync"] --> B["Contenu déposé à la main\n(files/www/)"]
  B --> C["Script widgets_sync.py"]
  C --> D["Listes widgets.json et bibjs.json"]
  D --> E["manifest.manual.json\n(variable widgets_manifest)"]
  E --> F["credentials.json (0600)\nidentifiants du proxy"]
  F --> G["Manifest initial\n(seulement s'il n'existe pas)"]
  G --> H["Configuration nginx\n+ docker-compose"]
  H --> I["docker compose up :\ncréation du conteneur widgets"]
  I --> J["widgets_sync.py :\ntéléchargement et manifest"]
  J --> K["Unités systemd :\nminuteur quotidien"]
  K --> L["Contrôle : GET /manifest.json = 200"]
```

### 7.3 Résultat attendu dans le journal

À la fin de la partie « Compte rendu de la synchronisation », une ligne de la forme :

```
SYNC: ok fichiers=214 modifies=215 supprimes=0 widgets=38 avertissements=2 erreurs=0
```

(les nombres dépendent des listes). Puis le bilan Ansible : `failed=0`.

| Ligne | Lecture |
|---|---|
| `SYNC: ok ... erreurs=0` | tout est téléchargé |
| `SYNC: partiel ... erreurs=N` | certains fichiers n'ont pas pu être téléchargés ; voir `report.json` (§7.4) |
| `SYNC: ÉCHEC ... 407` | identifiants du proxy refusés : vérifier le coffre (§5.3) |
| `SYNC: ÉCHEC ... aucun téléchargement` | réseau ou proxy : refaire le test du §4.2 |

Par défaut (`widgets_sync_strict: false`), un échec de téléchargement **ne fait pas échouer le déploiement** : le site démarre avec le manifest initial et se mettra à jour au prochain passage. Pour qu'il échoue, mettez `widgets_sync_strict: true`.

### 7.4 Contrôles sur le serveur Flask

```bash
# 1. le conteneur tourne
sudo docker ps --filter name=widgets

# 2. le site répond en local
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:8080/manifest.json

# 3. le manifest est valide et contient les widgets
curl -s http://127.0.0.1:8080/manifest.json | python3 -c "import sys,json; m=json.load(sys.stdin); print(len(m), 'widgets'); print(m[0]['url'] if m else '')"

# 4. le compte rendu de la synchronisation
sudo python3 -m json.tool /opt/widgets-site/sync/report.json | head -60

# 5. le minuteur est programmé
systemctl list-timers widgets-sync.timer
```

| Contrôle | Attendu |
|---|---|
| 1 | une ligne `widgets` en état `Up` |
| 2 | `HTTP 200` |
| 3 | un nombre de widgets non nul ; les adresses commencent par `http://optimis-developpement.minint.fr/plugin/` |
| 4 | `errors` vide ; lire `warnings` (§7.5) |
| 5 | une ligne avec la prochaine exécution (3 h 30) |

### 7.5 Lire le compte rendu

`/opt/widgets-site/sync/report.json` :

| Champ | Contenu | Action |
|---|---|---|
| `errors` | téléchargements impossibles | à corriger avant de continuer |
| `warnings` : « hôte ... absent de widget_hosts » | un widget est ignoré car son hôte n'est pas autorisé | ajoutez l'hôte à `widget_hosts` dans `widgets.json` si vous le voulez |
| `warnings` : « pas de sha256 ... (calculé : ...) » | bibliothèque non épinglée | copiez l'empreinte dans `bibjs.json` (§11.2) |
| `external_not_copied` | adresses externes trouvées mais non copiées | à ajouter à `bibjs.json` si le widget en a besoin |
| `widgets` | liste des widgets du manifest | à relire : tout widget copié devient du code servi sur votre domaine |

> Ces ajustements se feront dans une deuxième merge request, sans urgence : le site est déjà utilisable.

---

## 8. Étape 3 : le RPX (`rpx.yml`)

### 8.1 Contrôle préalable depuis le RPX

Avant de modifier Apache, vérifiez que le RPX **joint** le conteneur (c'est la règle Terraform de l'étape 1) :

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 5 http://opt-flask-python-1:8080/manifest.json
```

| Résultat | Décision |
|---|---|
| `HTTP 200` | continuez |
| expiration après 5 s | la règle Terraform n'est pas appliquée : retour à l'étape 1 |
| le nom ne se résout pas | vérifiez `widgets_internal_dns` (nom exact de l'instance) |

### 8.2 Lancer le pipeline

| Variable | Valeur |
|---|---|
| `ENVIRONMENT` | `dev` |
| `PLAYBOOK` | `rpx.yml` |
| `TARGET` | `rpx` |

Lancez **`Ansible Playbook S2R1`**.

### 8.3 Ce qui change

Un seul fichier de configuration d'Apache est modifié : `/etc/apache2/sites-available/grist.conf`, qui reçoit :

```apache
ProxyPass /plugin/ http://opt-flask-python-1:8080/
ProxyPassReverse /plugin/ http://opt-flask-python-1:8080/
```

placé **avant** `ProxyPass /`. Cet ordre est essentiel : Apache applique la première règle qui correspond, donc `/plugin/` doit être testé avant la règle générale qui renvoie tout à Grist.

La dernière tâche du rôle est un **`reload`** (pas un redémarrage) : Apache termine proprement les requêtes en cours et prend la nouvelle configuration. Si la nouvelle configuration était invalide, le `reload` échouerait et Apache **continuerait avec l'ancienne** : aucun risque de coupure.

### 8.4 Contrôles sur le RPX

```bash
sudo apache2ctl configtest                       # attendu : Syntax OK
grep -n "ProxyPass" /etc/apache2/sites-available/grist.conf
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://optimis-developpement.minint.fr/plugin/manifest.json
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://optimis-developpement.minint.fr/
```

| Contrôle | Attendu |
|---|---|
| `configtest` | `Syntax OK` |
| ordre des `ProxyPass` | la ligne `/plugin/` apparaît **avant** `ProxyPass / ` |
| `/plugin/manifest.json` | `HTTP 200` et du JSON (pas une page de Grist) |
| `/` | `HTTP 200` ou `302` comme avant : Grist et l'authentification fonctionnent toujours |

---

## 9. Étape 4 : Grist (`grist.yml`)

### 9.1 Précautions

Cette étape **recrée le conteneur Grist** : le service est indisponible quelques secondes.

- Choisissez un créneau calme et prévenez les utilisateurs.
- Vérifiez que le §5.4 n'a rien relevé d'autre dans `roles/grist` ni dans `http_proxy` et `no_proxy`.
- Le contrôle de l'étape 3 (`/plugin/manifest.json` répond en 200) doit avoir réussi : Grist ira chercher cette adresse.

### 9.2 Lancer le pipeline

| Variable | Valeur |
|---|---|
| `ENVIRONMENT` | `dev` |
| `PLAYBOOK` | `grist.yml` |
| `TARGET` | `grist` |

Lancez **`Ansible Playbook S2R1`**. Avec `TARGET=grist`, la première partie du playbook (base de données `psg`) est sautée.

### 9.3 Ce qui se passe

```mermaid
sequenceDiagram
  autonumber
  participant AN as Ansible
  participant HG as opt-grist-1
  participant DK as Docker
  participant GR as Conteneur Grist
  participant RP as RPX

  AN->>HG: réécrit /opt/grist/docker-compose.yml
  Note over HG: seule la valeur de GRIST_WIDGET_LIST_URL change
  AN->>DK: docker compose up (état : présent)
  DK->>GR: arrêt de l'ancien conteneur
  DK->>GR: démarrage du nouveau (quelques secondes)
  GR->>RP: lit /plugin/manifest.json (NO_PROXY : direct)
  RP-->>GR: la liste des widgets
```

### 9.4 Contrôles sur le serveur Grist

```bash
# 1. le conteneur est reparti
sudo docker ps --format '{{.Names}}\t{{.Status}}'

# 2. la nouvelle adresse est bien prise en compte (remplacez <nom> par le nom du conteneur Grist)
sudo docker exec <nom> printenv GRIST_WIDGET_LIST_URL
```

| Contrôle | Attendu |
|---|---|
| 1 | le conteneur Grist en `Up` depuis quelques secondes |
| 2 | `http://optimis-developpement.minint.fr/plugin/manifest.json` |

---

## 10. Étape 5 : validation de bout en bout

### 10.1 Test fonctionnel dans Grist

1. Ouvrez un document de test.
2. **Ajouter une page ou un widget**, choisissez **Personnalisé**.
3. Dans la liste « Sélectionner un widget personnalisé », vos widgets sont proposés.
4. Ajoutez-en un et vérifiez qu'il s'affiche.
5. Ouvrez les outils du navigateur (F12, onglet Réseau) : les requêtes du widget partent vers `http://optimis-developpement.minint.fr/plugin/...` (200), sans erreur de contenu mixte, ni `CORS`, ni blocage de CSP.

```mermaid
sequenceDiagram
  autonumber
  actor U as Utilisateur
  participant N as Navigateur
  participant R as RPX
  participant G as Grist
  participant W as nginx (widgets)

  U->>N: Ajouter un widget personnalisé
  N->>G: liste des widgets
  G-->>N: manifest (déjà lu depuis /plugin/manifest.json)
  U->>N: choisit un widget
  N->>R: GET /plugin/widget/.../index.html
  R->>W: GET /widget/.../index.html
  W-->>N: la page du widget
  N->>R: GET /plugin/bibjs/... (bibliothèques)
  R->>W: idem
  N->>G: API du document (jeton du widget)
```

### 10.2 Check-list de validation

| # | Contrôle | OK |
|---|---|---|
| 1 | Grist répond et l'authentification (Keycloak) fonctionne | ☐ |
| 2 | `/plugin/manifest.json` répond en 200 par le RPX | ☐ |
| 3 | un widget du manifest se charge dans un document | ☐ |
| 4 | aucune erreur de contenu mixte, de CORS ou de CSP dans la console | ☐ |
| 5 | `sync/report.json` : `errors` vide | ☐ |
| 6 | le minuteur `widgets-sync.timer` est programmé | ☐ |
| 7 | un widget existant (hors liste) fonctionne toujours | ☐ |

Si le widget **Sync+ (Constructeur)** est utilisé : `GRIST_ORIGINS` (début du script JS) doit contenir `http://optimis-developpement.minint.fr`, avec le même schéma que la barre d'adresse.

---

## 11. Après la mise en service

### 11.1 Mise à jour automatique

```mermaid
flowchart LR
  M["Minuteur systemd\nchaque jour 3 h 30"] --> S["widgets_sync.py"]
  S --> L["widgets.json\nbibjs.json"]
  S -->|"proxy authentifiant"| I["Internet"]
  S --> W["www/ (fichiers modifiés seulement)"]
  S --> MF["manifest.json régénéré"]
  S --> RP["sync/report.json"]
```

À savoir : en cas d'échec réseau, **la version précédente est conservée** ; si aucun téléchargement n'aboutit, **rien n'est modifié**.

| Besoin | Commande (sur le serveur Flask) |
|---|---|
| Lancer maintenant | `sudo systemctl start widgets-sync` |
| Voir le déroulé | `sudo journalctl -u widgets-sync -n 50 --no-pager` |
| Voir le bilan | `sudo python3 -m json.tool /opt/widgets-site/sync/report.json` |
| Prochaine exécution | `systemctl list-timers widgets-sync.timer` |

### 11.2 Épingler les bibliothèques (sha256)

1. Lisez les avertissements « pas de sha256 ... (calculé : XXXX) » dans `report.json`.
2. Copiez la valeur dans `bibjs.json` (`"sha256": "XXXX"`).
3. Faites une merge request, puis relancez `widgets.yml` (`TARGET=flask_python`).

Désormais, un fichier modifié à la source est **refusé** (erreur `sha256`), ce qui protège contre une altération.

### 11.3 Ajouter un widget plus tard

```mermaid
flowchart TD
  A["Besoin : un nouveau widget"] --> B{"Il figure déjà dans\nune liste suivie ?\n(manifest de Grist)"}
  B -- "oui" --> C["Rien à faire :\nle prochain passage le télécharge"]
  B -- "non" --> D{"Son hôte est autorisé ?\n(widget_hosts)"}
  D -- "non" --> E["Ajouter l'hôte dans widgets.json"]
  D -- "oui" --> F["Ajouter le widget dans widgets.json\n(url, ou archive + entry)"]
  E --> F
  F --> G["Merge request"]
  G --> H["Pipeline : widgets.yml\nTARGET=flask_python"]
  H --> I["Contrôler report.json\n(erreurs, avertissements)"]
```

Un ajout dans `widgets.json` ou `bibjs.json` ne touche ni le RPX ni Grist : **seul `widgets.yml` est à relancer** (ou attendre 3 h 30). Aucune coupure.

---

## 12. Retour arrière

Chaque étape se défait indépendamment. Défaites **dans l'ordre inverse** de la mise en service.

```mermaid
flowchart TD
  P["Problème constaté"] --> Q{"À quelle étape ?"}
  Q -- "Étape 4 : Grist" --> G["Remettre l'ancienne valeur de\ngrist_widget_list_url\npuis grist.yml (TARGET=grist)"]
  Q -- "Étape 3 : RPX" --> R["Retirer les deux lignes /plugin/\nde app.conf.j2\npuis rpx.yml (TARGET=rpx)"]
  Q -- "Étape 2 : widgets" --> W["Sur le serveur Flask :\ndocker compose down +\nminuteur arrêté (voir ci-dessous)"]
  Q -- "Étape 1 : Terraform" --> T["Retirer la règle 8080 de network.tf\npuis apply_plan et apply"]
  G --> R
  R --> W
  W --> T
```

| Étape | Retour arrière | Remarque |
|---|---|---|
| 4. Grist | rétablir `grist_widget_list_url` à son ancienne valeur dans `group_vars/grist.yml`, puis `grist.yml` avec `TARGET=grist` | nouvelle coupure de quelques secondes |
| 3. RPX | supprimer les deux lignes `/plugin/` de `app.conf.j2`, puis `rpx.yml` avec `TARGET=rpx` | `reload` gracieux |
| 2. Widgets | sur le serveur Flask : `cd /opt/widgets-site && sudo docker compose down` puis `sudo systemctl disable --now widgets-sync.timer` | les fichiers restent sur le disque ; pour les retirer : `sudo rm -rf /opt/widgets-site` |
| 1. Terraform | retirer la règle de `network.tf`, `apply_plan` puis `apply` | sans effet si plus rien n'utilise le port 8080 |

**Retour arrière rapide, sans pipeline, pour le RPX** (si un problème survient pendant l'étape 3) :

```bash
sudo cp /etc/apache2/sites-available/grist.conf /tmp/grist.conf.nouvelle
# retirer à la main les deux lignes /plugin/, puis :
sudo apache2ctl configtest && sudo systemctl reload apache2
```

Pensez ensuite à corriger le dépôt, sinon le prochain déploiement remettra la règle.

---

## 13. Variante : lancer depuis un poste ou en mode simulation

Si vous disposez d'un poste avec accès au dépôt, à l'inventaire OpenStack et au mot de passe du coffre :

```bash
cd ansible
export OS_USERNAME=...   # variables OpenStack habituelles
ansible-playbook -i inventories/dev/openstack.yml playbooks/widgets.yml \
  --limit flask_python --ask-vault-pass --check --diff
```

`--check --diff` **simule** le déploiement et affiche les changements sans rien modifier. Retirez ces deux options pour exécuter réellement.

> En mode simulation, certaines tâches qui dépendent d'étapes précédentes (démarrage du conteneur, test du manifest) peuvent signaler une erreur sans gravité : le but est de lire le **diff** des fichiers.

### 13.1 Proposition : une variable `ANSIBLE_ARGS` dans la CI

Pour pouvoir simuler depuis le pipeline, ajoutez dans `.gitlab-ci.yml` (non fourni dans le zip) :

```yaml
variables:
  ANSIBLE_ARGS:
    description: "Options ansible-playbook (ex. : --check --diff)"
    value: ""
```

et dans les deux jobs `Ansible Playbook S2R1` / `S2R2` :

```yaml
  script:
    - ansible-playbook -i inventories/${ENVIRONMENT}/openstack.yml playbooks/${PLAYBOOK} --limit "$TARGET" ${ANSIBLE_ARGS}
```

Vous pourrez alors lancer chaque étape une première fois avec `--check --diff`, lire le résultat, puis la relancer sans option.

---

## 14. Dépannage

### 14.1 Pendant le pipeline

| Symptôme | Cause probable | Action |
|---|---|---|
| `Decryption failed` ou `Attempting to decrypt but no vault secrets found` | le coffre n'est pas déchiffré | vérifier la variable CI `ANSIBLE_VAULT_PASSWORD_FILE` (type Fichier) et sa protection |
| `The conditional check ... widgets_proxy_user is undefined` | `vault.yml` absent ou non chargé | vérifier son emplacement : `group_vars/flask_python/vault.yml` |
| `No such image` ou erreur de pull | chemin d'image ou accès Artifactory | §4.1 |
| `Could not resolve host` pour le serveur Flask | mauvais `widgets_internal_dns` | nom exact de l'instance |
| Le job ne démarre pas | variables ou règles de workflow | `ENVIRONMENT` doit valoir `dev` |
| `--limit` : « Specified inventory, host pattern and/or --limit leaves us with no hosts » | `TARGET` incorrect | utiliser le nom exact du groupe (`flask_python`, `rpx`, `grist`) |

### 14.2 Après le déploiement

| Symptôme | Cause probable | Action |
|---|---|---|
| `SYNC: ÉCHEC ... 407` | identifiants du proxy refusés | refaire le coffre (§5.3) puis relancer `widgets.yml` |
| `SYNC: ÉCHEC ... aucun téléchargement` | proxy inaccessible, ou TLS inspecté | test du §4.2 ; si le proxy inspecte le TLS, renseigner `widgets_ca_bundle: /etc/ssl/certs/ca-certificates.crt` |
| `curl` du RPX vers le 8080 : expiration | règle Terraform absente | étape 1 |
| `/plugin/manifest.json` renvoie une page de Grist | règle `/plugin/` placée après `ProxyPass /` | vérifier l'ordre dans `grist.conf` |
| Aucun widget dans la liste de Grist | manifest vide, ou Grist n'a pas redémarré | vérifier `GRIST_WIDGET_LIST_URL` dans le conteneur (§9.4) |
| Le widget s'affiche mais est incomplet | dépendance externe non copiée | `report.json` : `external_not_copied` ; ajouter l'hôte à `external_hosts` ou la bibliothèque à `bibjs.json` |
| Un widget manque dans le manifest | son hôte n'est pas autorisé | avertissement dans `report.json` ; ajouter l'hôte à `widget_hosts` |
| `otherInstance` dans Sync+ | `GRIST_ORIGINS` incorrect | adresse exacte de Grist, même schéma que la barre d'adresse |
| Contenu mixte | une adresse en `https://` subsiste | relancer la synchronisation (les adresses sont réécrites) |

---

## 15. Fiche récapitulative

| Étape | Variables du pipeline | Impact | Contrôle clé |
|---|---|---|---|
| 0. Préparer | (aucun pipeline) | aucun | `git diff` ne montre que les nouveautés ; test du script OK |
| 1. Terraform | `ENVIRONMENT=dev` : `apply_plan` puis `apply` | +1 règle de sécurité | `Plan: 1 to add, 0 to change, 0 to destroy` |
| 2. Widgets | `PLAYBOOK=widgets.yml` `TARGET=flask_python` | nouveau conteneur | `SYNC: ok ... erreurs=0` ; `curl` local 200 |
| 3. RPX | `PLAYBOOK=rpx.yml` `TARGET=rpx` | `reload` d'Apache, sans coupure | `/plugin/manifest.json` 200 par le RPX |
| 4. Grist | `PLAYBOOK=grist.yml` `TARGET=grist` | Grist recréé, quelques secondes | les widgets apparaissent dans la liste |
| 5. Valider | (manuel) | aucun | check-list du §10.2 |

**À retenir**

- Jamais `deploy_all.yml` pour cette évolution.
- Toujours `TARGET` renseigné.
- Un contrôle entre chaque étape, avant de passer à la suivante.
- Les identifiants du proxy restent dans un coffre Ansible chiffré.
- Pour ajouter un widget ou une bibliothèque : modifier `widgets.json` ou `bibjs.json`, puis relancer **seulement** `widgets.yml`.
