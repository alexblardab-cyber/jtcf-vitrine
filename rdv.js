/* ==========================================================================
   JTCF — Rendez-vous
   --------------------------------------------------------------------------
   CE QUI A CHANGÉ (septembre 2026)

   Avant, un créneau était une date précise qu'il fallait publier à la main,
   semaine après semaine. Quand il n'y en avait plus, l'apprenant qui ouvrait
   l'onglet ne voyait rien — et n'y revenait pas.

   Maintenant, chacun déclare une PERMANENCE qui revient toutes les semaines
   (« je reçois le mardi de 14h à 16h, par créneaux de 30 minutes »), et
   l'application calcule les disponibilités toute l'année. On ne publie plus
   rien : on FERME les jours ou les heures où l'on n'est pas là.

   Et la réservation n'est plus ferme : l'apprenant DEMANDE un créneau,
   l'équipe accepte ou refuse. Le créneau est bloqué le temps de la réponse.

   --------------------------------------------------------------------------
   DANS FIREBASE

     permanences/{id}  → les disponibilités qui se répètent chaque semaine
       { par, jour(1=lundi…5=vendredi), debut, fin, duree, lieu, actif, le }

     fermetures/{id}   → les exceptions : je ne suis pas là ce jour-là
       { par, date, heure('' = toute la journée), motif, le }

     creneaux/{par_date_heure}  → uniquement quand il se passe quelque chose
       { par, date, heure, duree, lieu, etat, demandeur, reponse, repondu, … }
       etat : 'demande' | 'confirme' | 'refuse' | 'annule'
       La clé est calculée : deux personnes ne peuvent pas prendre le même
       créneau, même en cliquant exactement en même temps.

     rdvDemandes/{id}  → demande libre (« je ne peux à aucun de ces horaires »)
     convocations/{id} → l'équipe propose une date, l'apprenant répond

   Les deux derniers nœuds n'ont pas bougé : le script d'alertes continue de
   fonctionner sans modification.
   ========================================================================== */

(function (global) {
  'use strict';

  /* ---- L'équipe ----------------------------------------------------------- */

  var CONSEILLERS = {
    AB: { nom: 'Alexandre Blard', role: 'Conseiller en Formation / Assistant de Direction', couleur: '#2C6E9B' },
    MG: { nom: 'Marine Grondin', role: 'Conseillère en Insertion Professionnelle / ARH', couleur: '#6b46c1' },
    EF: { nom: 'Emilie Fontaine', role: 'Formatrice', couleur: '#2f855a' }
  };

  var MOTIFS = [
    'Suivi de mon parcours',
    'Difficulté personnelle',
    'Question administrative (contrat, rémunération)',
    'Relation avec mon entreprise',
    'Recherche d\'entreprise ou d\'emploi',
    'Préparation d\'un examen',
    'Justifier une absence ou un retard',
    'Autre'
  ];

  var LIEU_DEFAUT = 'Bureau JTCF — 20a rue du Général Lambert';

  /* Alexandre et Marine reçoivent dans LE MÊME bureau : un rendez-vous pris
     par l'un rend l'heure indisponible pour l'autre. Emilie a sa salle, elle
     n'est pas concernée. Pour ajouter quelqu'un au bureau partagé, il suffit
     d'ajouter son code ici.                                                  */
  var BUREAU_PARTAGE = ['AB', 'MG'];
  var MOIS_VISIBLES = 12;        // on n'affiche pas au-delà d'un an

  /* ---- Utilitaires -------------------------------------------------------- */

  var api = null;      // { lire(chemin), ecrire(chemin, valeur) }
  var moi = null;      // { id, nom, type }
  var annuaire = [];

  var JOURS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
              'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  function id(p) { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function ech(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Attention au fuseau : La Réunion est à UTC+4, toISOString reculerait d'un jour.
  function iso(d) {
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function isoAujourdhui() { return iso(new Date()); }
  function dateDe(i) { var p = String(i || '').split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }

  function joli(i) {
    var p = String(i || '').split('-');
    if (p.length !== 3) return i || '—';
    var d = dateDe(i);
    return JOURS[d.getDay()] + ' ' + (+p[2]) + ' ' + MOIS[+p[1] - 1];
  }
  function joliCourt(i) {
    var p = String(i || '').split('-');
    if (p.length !== 3) return i || '—';
    return (+p[2]) + ' ' + MOIS[+p[1] - 1].slice(0, 4) + '.';
  }

  function minutes(h) { return (+String(h).slice(0, 2)) * 60 + (+String(h).slice(3, 5)); }
  function heureDe(m) { return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }

  function conseiller(c) {
    return CONSEILLERS[c] || { nom: c || 'L\'équipe', role: '', couleur: '#718096' };
  }
  function codes(par) {
    return String(par || '').split(',').map(function (c) { return c.trim(); }).filter(Boolean);
  }
  function estEquipe(par) { return codes(par).length >= Object.keys(CONSEILLERS).length; }

  function libelleParticipants(par) {
    var l = codes(par);
    if (!l.length) return 'L\'équipe';
    if (l.length === 1) return conseiller(l[0]).nom;
    if (estEquipe(par)) return 'Toute l\'équipe pédagogique';
    return l.map(function (c) { return conseiller(c).nom.split(' ')[0]; }).join(' et ');
  }
  function participe(par, role) { return role === 'admin' || codes(par).indexOf(role) >= 0; }

  function objetVersListe(o) {
    return Object.keys(o || {}).map(function (k) {
      var v = o[k] || {}; v._id = k; return v;
    });
  }

  async function chargerAnnuaire() {
    if (annuaire.length) return annuaire;
    var lots = await Promise.all([
      api.lire('alternants'), api.lire('stagiairesFC'), api.lire('stagiaires')
    ]);
    var types = ['alt', 'fc', 'stg'];
    annuaire = [];
    lots.forEach(function (o, i) {
      Object.keys(o || {}).forEach(function (k) {
        annuaire.push({ id: k, nom: (o[k] && o[k].nom) || k, type: types[i] });
      });
    });
    annuaire.sort(function (a, b) { return a.nom.localeCompare(b.nom); });
    return annuaire;
  }

  /* ══ LE CALCUL DES CRÉNEAUX ═══════════════════════════════════════════════
     Personne ne publie plus de créneaux : on les déduit des permanences,
     on enlève les fermetures, les jours fériés, et ce qui est déjà pris.   */

  // Jours fériés et fermetures du centre, quand regles.js est chargé.
  function ferie(isoJour) {
    var J = global.JTCF;
    if (!J || !J.FERIES_FC) return false;
    return J.FERIES_FC.indexOf(isoJour) >= 0;
  }

  function cle(par, date, heure) {
    return par + '_' + date.replace(/-/g, '') + '_' + heure.replace(':', '');
  }

  // Toutes les cases d'une journée pour une permanence donnée.
  function casesDe(p) {
    var out = [], m1 = minutes(p.debut), m2 = minutes(p.fin), d = p.duree || 30;
    for (var t = m1; t + d <= m2; t += d) out.push(heureDe(t));
    return out;
  }

  /* Renvoie la liste des créneaux d'une journée, avec leur état.
     etat : 'libre' | 'demande' | 'confirme' | 'ferme'                        */
  function creneauxDuJour(isoJour, permanences, fermetures, occupes, filtreConseiller) {
    if (ferie(isoJour)) return [];
    var jour = dateDe(isoJour).getDay();
    if (jour === 0 || jour === 6) return [];

    var out = [];
    permanences.forEach(function (p) {
      if (p.actif === false) return;
      if (p.jour !== jour) return;
      if (filtreConseiller && p.par !== filtreConseiller) return;
      if (p.depuis && isoJour < p.depuis) return;
      if (p.jusqua && isoJour > p.jusqua) return;

      // Journée entière fermée pour ce conseiller ?
      var fermeJour = fermetures.some(function (f) {
        return f.date === isoJour && !f.heure && (f.par === p.par || f.par === '*');
      });
      if (fermeJour) return;

      casesDe(p).forEach(function (h) {
        var fermeHeure = fermetures.some(function (f) {
          return f.date === isoJour && f.heure === h && (f.par === p.par || f.par === '*');
        });
        var pris = occupantDe(occupes, p.par, isoJour, h);
        out.push({
          par: p.par, date: isoJour, heure: h, duree: p.duree || 30,
          lieu: p.lieu || LIEU_DEFAUT,
          etat: fermeHeure ? 'ferme'
              : (pris ? (pris.etat === 'demande' ? 'demande' : 'confirme') : 'libre'),
          // Le bureau est-il occupé par un collègue plutôt que par soi-même ?
          parCollegue: !!(pris && pris.par !== p.par),
          dossier: pris || null
        });
      });
    });
    return out.sort(function (a, b) { return a.heure.localeCompare(b.heure) || a.par.localeCompare(b.par); });
  }

  /* Qui occupe cette heure-là ? Pour le bureau partagé, on regarde aussi les
     collègues : deux personnes ne peuvent pas recevoir en même temps.        */
  function occupantDe(occupes, par, date, heure) {
    var direct = occupes[cle(par, date, heure)];
    if (direct) return direct;
    if (BUREAU_PARTAGE.indexOf(par) < 0) return null;
    for (var i = 0; i < BUREAU_PARTAGE.length; i++) {
      var o = occupes[cle(BUREAU_PARTAGE[i], date, heure)];
      if (o) return o;
    }
    return null;
  }

  // Les créneaux déjà engagés, rangés par clé pour un accès immédiat.
  function indexOccupes(liste) {
    var m = {};
    liste.forEach(function (c) {
      if (c.etat === 'demande' || c.etat === 'confirme') m[cle(c.par, c.date, c.heure)] = c;
    });
    return m;
  }

  async function chargerTout() {
    var lots = await Promise.all([
      api.lire('permanences'), api.lire('fermetures'), api.lire('creneaux'),
      api.lire('rdvDemandes'), api.lire('convocations'), api.lire('passages')
    ]);
    return {
      permanences: objetVersListe(lots[0]),
      fermetures: objetVersListe(lots[1]),
      creneaux: objetVersListe(lots[2]),
      demandes: objetVersListe(lots[3]),
      convocations: objetVersListe(lots[4]),
      passages: objetVersListe(lots[5])
    };
  }

  /* ══ CÔTÉ APPRENANT ═══════════════════════════════════════════════════════ */

  var moisAffiche = null;   // {a, m} — le mois montré dans le calendrier

  async function rendreApprenant(boite) {
    boite.innerHTML = '<div style="text-align:center;padding:30px;opacity:.6;">Chargement…</div>';
    var d = await chargerTout();
    var occupes = indexOccupes(d.creneaux);
    var auj = isoAujourdhui();

    if (!moisAffiche) { var n = new Date(); moisAffiche = { a: n.getFullYear(), m: n.getMonth() }; }

    /* --- Ce qui me concerne --- */
    var mesCreneaux = d.creneaux.filter(function (c) {
      return c.demandeur && c.demandeur.id === moi.id
        && (c.etat === 'demande' || c.etat === 'confirme') && c.date >= auj;
    }).sort(function (a, b) { return (a.date + a.heure).localeCompare(b.date + b.heure); });

    var mesDemandes = d.demandes.filter(function (x) {
      return x.qui === moi.id && (x.etat === 'demande' || x.etat === 'confirme');
    });

    var mesConvocs = d.convocations.filter(function (c) {
      return c.pour === moi.id && (c.etat === 'propose' || c.etat === 'accepte') && c.date >= auj;
    }).sort(function (a, b) { return (a.date + a.heure).localeCompare(b.date + b.heure); });

    var h = '';

    h += '<div style="background:var(--or-pale,#fdf6e3);border-left:4px solid var(--or,#C9A227);'
       + 'border-radius:0 10px 10px 0;padding:13px 16px;font-size:13px;line-height:1.65;margin-bottom:16px;color:#5a4510;">'
       + '<strong>Besoin de nous voir ?</strong><br>'
       + 'Choisissez un créneau ci-dessous. Votre demande nous arrive aussitôt, '
       + 'et vous recevez la confirmation dès qu\'elle est validée.'
       + '</div>';

    /* --- Convocations à répondre --- */
    mesConvocs.filter(function (c) { return c.etat === 'propose'; }).forEach(function (c) {
      h += '<div style="background:#fff5f5;border:2px solid #fc8181;border-radius:12px;padding:15px;margin-bottom:12px;">'
        + '<div style="font-size:11px;font-weight:800;letter-spacing:1px;color:#c53030;">📨 ON VOUS PROPOSE UN RENDEZ-VOUS</div>'
        + '<div style="font-weight:800;margin:6px 0 2px;">' + joli(c.date) + ' à ' + ech(c.heure) + '</div>'
        + '<div style="font-size:13px;opacity:.85;">avec ' + ech(libelleParticipants(c.par)) + '</div>'
        + (c.motif ? '<div style="font-size:13px;margin-top:6px;">Motif : ' + ech(c.motif) + '</div>' : '')
        + (c.message ? '<div style="font-size:13px;margin-top:4px;font-style:italic;">« ' + ech(c.message) + ' »</div>' : '')
        + '<div style="display:flex;gap:8px;margin-top:12px;">'
        + '<button class="btn-convoc-oui" data-c="' + c._id + '" style="flex:1;padding:11px;border:none;border-radius:9px;background:#38a169;color:#fff;font-weight:800;font-family:inherit;cursor:pointer;">✅ Je serai là</button>'
        + '<button class="btn-convoc-non" data-c="' + c._id + '" style="flex:1;padding:11px;border:none;border-radius:9px;background:#e53e3e;color:#fff;font-weight:800;font-family:inherit;cursor:pointer;">Je ne peux pas</button>'
        + '</div></div>';
    });

    /* --- Mes rendez-vous --- */
    if (mesCreneaux.length || mesConvocs.some(function (c) { return c.etat === 'accepte'; }) || mesDemandes.length) {
      h += '<div style="font-size:12px;font-weight:800;letter-spacing:1px;opacity:.6;margin:18px 0 8px;">MES RENDEZ-VOUS</div>';

      mesCreneaux.forEach(function (c) {
        var attente = c.etat === 'demande';
        h += '<div style="background:#fff;border:1px solid #e2e8f0;border-left:4px solid '
          + (attente ? '#C9A227' : '#38a169') + ';border-radius:0 10px 10px 0;padding:12px 14px;margin-bottom:8px;">'
          + '<div style="font-size:11px;font-weight:800;letter-spacing:1px;color:' + (attente ? '#975a16' : '#276749') + ';">'
          + (attente ? '⏳ EN ATTENTE DE VALIDATION' : '✅ CONFIRMÉ') + '</div>'
          + '<div style="font-weight:800;margin-top:4px;">' + joli(c.date) + ' à ' + ech(c.heure) + '</div>'
          + '<div style="font-size:13px;opacity:.8;">avec ' + ech(libelleParticipants(c.par)) + ' · ' + ech(c.lieu || LIEU_DEFAUT) + '</div>'
          + '<button class="btn-annuler-cr" data-c="' + c._id + '" style="margin-top:9px;padding:7px 13px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;font-size:12px;font-family:inherit;cursor:pointer;color:#718096;">Annuler</button>'
          + '</div>';
      });

      mesConvocs.filter(function (c) { return c.etat === 'accepte'; }).forEach(function (c) {
        h += '<div style="background:#fff;border:1px solid #e2e8f0;border-left:4px solid #38a169;border-radius:0 10px 10px 0;padding:12px 14px;margin-bottom:8px;">'
          + '<div style="font-size:11px;font-weight:800;letter-spacing:1px;color:#276749;">✅ CONFIRMÉ</div>'
          + '<div style="font-weight:800;margin-top:4px;">' + joli(c.date) + ' à ' + ech(c.heure) + '</div>'
          + '<div style="font-size:13px;opacity:.8;">avec ' + ech(libelleParticipants(c.par)) + '</div>'
          + '</div>';
      });

      mesDemandes.forEach(function (x) {
        h += '<div style="background:#fff;border:1px solid #e2e8f0;border-left:4px solid #718096;border-radius:0 10px 10px 0;padding:12px 14px;margin-bottom:8px;">'
          + '<div style="font-size:11px;font-weight:800;letter-spacing:1px;opacity:.6;">'
          + (x.etat === 'confirme' ? '✅ RÉPONDU' : '⏳ DEMANDE LIBRE EN COURS') + '</div>'
          + '<div style="font-size:13px;margin-top:4px;">' + ech(x.motif || '') + '</div>'
          + (x.reponse ? '<div style="font-size:13px;margin-top:5px;font-style:italic;">« ' + ech(x.reponse) + ' »</div>' : '')
          + (x.etat !== 'confirme'
              ? '<button class="btn-annuler-dem" data-d="' + x._id + '" style="margin-top:9px;padding:7px 13px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;font-size:12px;font-family:inherit;cursor:pointer;color:#718096;">Annuler</button>'
              : '')
          + '</div>';
      });
    }

    /* --- Le calendrier --- */
    h += '<div style="font-size:12px;font-weight:800;letter-spacing:1px;opacity:.6;margin:20px 0 8px;">CHOISIR UN CRÉNEAU</div>';
    h += calendrierHTML(d, occupes, auj);

    /* --- Demande libre --- */
    h += '<div style="margin-top:18px;text-align:center;">'
      + '<button id="rdvLibre" style="padding:11px 18px;border:1px dashed #cbd5e0;border-radius:10px;background:#fff;'
      + 'font-size:13px;font-family:inherit;cursor:pointer;color:#4a5568;">Aucun horaire ne me convient — proposer autre chose</button>'
      + '</div>';

    boite.innerHTML = h;
    brancherApprenant(boite);
  }

  /* Le calendrier mensuel : les jours qui ont au moins un créneau libre. */
  function calendrierHTML(d, occupes, auj) {
    var a = moisAffiche.a, m = moisAffiche.m;
    var premier = new Date(a, m, 1);
    var nbJours = new Date(a, m + 1, 0).getDate();
    var decalage = (premier.getDay() + 6) % 7;   // lundi en première colonne

    var max = new Date(); max.setMonth(max.getMonth() + MOIS_VISIBLES);
    var avantPossible = new Date(a, m, 1) > new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    var apresPossible = new Date(a, m, 1) < new Date(max.getFullYear(), max.getMonth(), 1);

    var h = '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;">';
    h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">'
      + '<button id="moisAvant" ' + (avantPossible ? '' : 'disabled')
      + ' style="border:none;background:none;font-size:20px;cursor:pointer;padding:4px 10px;opacity:' + (avantPossible ? '1' : '.25') + ';">‹</button>'
      + '<div style="font-weight:800;font-size:15px;text-transform:capitalize;">' + MOIS[m] + ' ' + a + '</div>'
      + '<button id="moisApres" ' + (apresPossible ? '' : 'disabled')
      + ' style="border:none;background:none;font-size:20px;cursor:pointer;padding:4px 10px;opacity:' + (apresPossible ? '1' : '.25') + ';">›</button>'
      + '</div>';

    h += '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;text-align:center;font-size:10px;'
      + 'font-weight:800;opacity:.5;margin-bottom:4px;">'
      + ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(function (j) { return '<div>' + j + '</div>'; }).join('')
      + '</div>';

    h += '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;">';
    for (var i = 0; i < decalage; i++) h += '<div></div>';

    for (var j = 1; j <= nbJours; j++) {
      var ij = iso(new Date(a, m, j));
      var libres = creneauxDuJour(ij, d.permanences, d.fermetures, occupes).filter(function (c) { return c.etat === 'libre'; });
      var passe = ij < auj;
      var dispo = !passe && libres.length > 0;
      h += '<button ' + (dispo ? 'class="jour-dispo" data-j="' + ij + '"' : 'disabled')
        + ' style="aspect-ratio:1;border:none;border-radius:9px;font-family:inherit;font-size:13px;font-weight:700;'
        + 'cursor:' + (dispo ? 'pointer' : 'default') + ';'
        + (dispo ? 'background:#e6f4ea;color:#276749;border:1px solid #9ae6b4;'
                 : 'background:#f7fafc;color:#cbd5e0;')
        + '">' + j
        + (dispo ? '<div style="font-size:9px;font-weight:800;">' + libres.length + '</div>' : '')
        + '</button>';
    }
    h += '</div>';
    h += '<div id="heuresDuJour" style="margin-top:12px;"></div>';
    h += '</div>';
    return h;
  }

  function brancherApprenant(boite) {
    var av = boite.querySelector('#moisAvant'), ap = boite.querySelector('#moisApres');
    if (av) av.addEventListener('click', function () {
      moisAffiche.m--; if (moisAffiche.m < 0) { moisAffiche.m = 11; moisAffiche.a--; }
      rendreApprenant(boite);
    });
    if (ap) ap.addEventListener('click', function () {
      moisAffiche.m++; if (moisAffiche.m > 11) { moisAffiche.m = 0; moisAffiche.a++; }
      rendreApprenant(boite);
    });

    boite.querySelectorAll('.jour-dispo').forEach(function (b) {
      b.addEventListener('click', function () { montrerHeures(boite, b.getAttribute('data-j')); });
    });
    boite.querySelectorAll('.btn-convoc-oui').forEach(function (b) {
      b.addEventListener('click', function () { repondreConvocation(b.getAttribute('data-c'), true, boite); });
    });
    boite.querySelectorAll('.btn-convoc-non').forEach(function (b) {
      b.addEventListener('click', function () { repondreConvocation(b.getAttribute('data-c'), false, boite); });
    });
    boite.querySelectorAll('.btn-annuler-cr').forEach(function (b) {
      b.addEventListener('click', function () { annulerMonCreneau(b.getAttribute('data-c'), boite); });
    });
    boite.querySelectorAll('.btn-annuler-dem').forEach(function (b) {
      b.addEventListener('click', function () { annulerDemande(b.getAttribute('data-d'), boite); });
    });
    var lib = boite.querySelector('#rdvLibre');
    if (lib) lib.addEventListener('click', function () { demandeLibre(boite); });
  }

  async function montrerHeures(boite, isoJour) {
    var zone = boite.querySelector('#heuresDuJour');
    if (!zone) return;
    zone.innerHTML = '<div style="opacity:.6;font-size:13px;">Chargement…</div>';
    var d = await chargerTout();
    var libres = creneauxDuJour(isoJour, d.permanences, d.fermetures, indexOccupes(d.creneaux))
      .filter(function (c) { return c.etat === 'libre'; });

    if (!libres.length) { zone.innerHTML = '<div style="opacity:.6;font-size:13px;">Plus de créneau libre ce jour-là.</div>'; return; }

    var h = '<div style="font-size:12px;font-weight:800;margin-bottom:8px;">' + joli(isoJour) + '</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:7px;">';
    libres.forEach(function (c) {
      h += '<button class="btn-prendre" data-p="' + c.par + '" data-d="' + c.date + '" data-h="' + c.heure + '"'
        + ' style="padding:9px 13px;border:1px solid ' + conseiller(c.par).couleur + ';border-radius:9px;background:#fff;'
        + 'color:' + conseiller(c.par).couleur + ';font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;">'
        + c.heure + '<span style="display:block;font-size:10px;font-weight:600;opacity:.75;">'
        + ech(conseiller(c.par).nom.split(' ')[0]) + '</span></button>';
    });
    h += '</div>';
    zone.innerHTML = h;

    zone.querySelectorAll('.btn-prendre').forEach(function (b) {
      b.addEventListener('click', function () {
        demander(b.getAttribute('data-p'), b.getAttribute('data-d'), b.getAttribute('data-h'), boite);
      });
    });
  }

  async function demander(par, date, heure, boite) {
    var k = cle(par, date, heure);
    var deja = await api.lire('creneaux/' + k);
    if (deja && (deja.etat === 'demande' || deja.etat === 'confirme')) {
      alert('Ce créneau vient d\'être pris. Choisissez-en un autre.');
      return rendreApprenant(boite);
    }

    formulaire('Rendez-vous avec ' + conseiller(par).nom + '\n' + joli(date) + ' à ' + heure, [
      { id:'motif', label:'Motif de votre demande', type:'select', valeur:MOTIFS[0],
        options:MOTIFS.map(function (m) { return [m, m]; }) },
      { id:'precision', label:'Précisez en quelques mots (facultatif)', type:'textarea',
        aide:'Ce que vous souhaitez aborder' }
    ], async function (v) {
      var encore = await api.lire('creneaux/' + k);
      if (encore && (encore.etat === 'demande' || encore.etat === 'confirme')) {
        throw new Error('ce créneau vient d\'être pris');
      }

      var perms = objetVersListe(await api.lire('permanences'));
      var jour = dateDe(date).getDay();
      var p = perms.filter(function (x) { return x.par === par && x.jour === jour && x.actif !== false; })[0] || {};

      await api.ecrire('creneaux/' + k, {
        par: par, date: date, heure: heure,
        duree: p.duree || 30, lieu: p.lieu || LIEU_DEFAUT,
        etat: 'demande',
        demandeur: {
          id: moi.id, nom: moi.nom, type: moi.type,
          motif: v.motif + (v.precision ? ' — ' + v.precision : ''),
          le: new Date().toISOString()
        },
        reponse: '', repondu: '', traitePar: '',
        notifie: false, notifieReponse: true
      });

      alert('✅ Demande envoyée\n\n' + joli(date) + ' à ' + heure
        + '\navec ' + conseiller(par).nom
        + '\n\nVous recevrez la confirmation dès qu\'elle sera validée.');
      rendreApprenant(boite);
    });
  }

  async function annulerMonCreneau(k, boite) {
    if (!confirm('Annuler ce rendez-vous ?\n\nLe créneau redeviendra disponible.')) return;
    await api.ecrire('creneaux/' + k, null);
    rendreApprenant(boite);
  }

  async function repondreConvocation(cid, accepte, boite) {
    if (accepte) {
      await api.ecrire('convocations/' + cid + '/etat', 'accepte');
      await api.ecrire('convocations/' + cid + '/repondu', new Date().toISOString());
      await api.ecrire('convocations/' + cid + '/notifieReponse', false);
      alert('✅ C\'est noté, nous vous attendons.');
    } else {
      var raison = prompt('Vous ne pouvez pas venir à cette date.\n\n'
        + 'Dites-nous pourquoi, et quand vous seriez disponible :', '');
      if (raison === null) return;
      await api.ecrire('convocations/' + cid + '/etat', 'refuse');
      await api.ecrire('convocations/' + cid + '/reponse', (raison || '').trim());
      await api.ecrire('convocations/' + cid + '/repondu', new Date().toISOString());
      await api.ecrire('convocations/' + cid + '/notifieReponse', false);
      alert('C\'est noté. Nous revenons vers vous avec une autre proposition.');
    }
    rendreApprenant(boite);
  }

  async function annulerDemande(did, boite) {
    if (!confirm('Annuler votre demande ?')) return;
    await api.ecrire('rdvDemandes/' + did + '/etat', 'annule');
    rendreApprenant(boite);
  }

  async function demandeLibre(boite) {
    formulaire('Proposer un autre moment', [
      { id:'motif', label:'Motif de votre demande', type:'select', valeur:MOTIFS[0],
        options:MOTIFS.map(function (m) { return [m, m]; }) },
      { id:'avec', label:'Avec qui', type:'select', valeur:'?',
        options:[['?', 'Peu importe']].concat(
          Object.keys(CONSEILLERS).map(function (c) { return [c, CONSEILLERS[c].nom]; })) },
      { id:'dispo', label:'Vos disponibilités', type:'text', requis:true,
        aide:'Ex : les lundis après-midi, ou après 16h' },
      { id:'message', label:'Un mot à ajouter (facultatif)', type:'textarea' }
    ], async function (v) {
      await api.ecrire('rdvDemandes/' + id('d'), {
        qui: moi.id, nom: moi.nom, type: moi.type,
        avec: v.avec, motif: v.motif, dispo: v.dispo, message: v.message,
        etat: 'demande', reponse: '', quand: '',
        le: new Date().toISOString(), notifie: false
      });
      alert('✅ Votre demande est envoyée. Nous revenons vers vous rapidement.');
      rendreApprenant(boite);
    });
  }

  /* ══ CÔTÉ ÉQUIPE ══════════════════════════════════════════════════════════ */

  var vue = 'valider';   // 'valider' | 'semaine' | 'permanences' | 'convoquer'

  async function rendreEquipe(boite, role) {
    boite.innerHTML = '<div style="text-align:center;padding:30px;opacity:.6;">Chargement…</div>';
    var d = await chargerTout();
    var auj = isoAujourdhui();
    var moiSeul = role === 'admin' ? null : role;

    var onglets = [
      ['valider', '✅ À valider'],
      ['semaine', '📅 Ma semaine'],
      ['permanences', '🗓️ Mes permanences'],
      ['convoquer', '📨 Convoquer']
    ];

    var h = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;">';
    onglets.forEach(function (o) {
      var actif = vue === o[0];
      h += '<button class="rdv-onglet" data-v="' + o[0] + '" style="padding:9px 14px;border:none;border-radius:9px;'
        + 'font-family:inherit;font-size:13px;font-weight:800;cursor:pointer;'
        + (actif ? 'background:var(--bleu-fonce,#2a3f4e);color:#fff;' : 'background:#edf2f7;color:#4a5568;')
        + '">' + o[1] + '</button>';
    });
    h += '</div>';

    if (vue === 'valider')      h += vueValider(d, role, auj);
    if (vue === 'semaine')      h += vueSemaine(d, role, auj);
    if (vue === 'permanences')  h += vuePermanences(d, moiSeul);
    if (vue === 'convoquer')    h += await vueConvoquer(d, role);

    boite.innerHTML = h;
    brancherEquipe(boite, role);
  }

  /* --- À valider --- */
  function vueValider(d, role, auj) {
    var h = '';
    var aValider = d.creneaux.filter(function (c) {
      return c.etat === 'demande' && c.date >= auj && (role === 'admin' || c.par === role);
    }).sort(function (a, b) { return (a.date + a.heure).localeCompare(b.date + b.heure); });

    var libres = d.demandes.filter(function (x) {
      return x.etat === 'demande' && (role === 'admin' || x.avec === '?' || participe(x.avec, role));
    });

    var refusees = d.convocations.filter(function (c) {
      return c.etat === 'refuse' && (role === 'admin' || participe(c.par, role));
    });

    if (!aValider.length && !libres.length && !refusees.length) {
      return '<div style="text-align:center;padding:34px;opacity:.55;font-size:14px;">'
           + '👌 Rien à valider pour le moment.</div>';
    }

    aValider.forEach(function (c) {
      var dem = c.demandeur || {};
      h += '<div style="background:#fffaf0;border:1px solid #fbd38d;border-radius:12px;padding:14px;margin-bottom:10px;">'
        + '<div style="font-size:11px;font-weight:800;letter-spacing:1px;color:#975a16;">⏳ DEMANDE DE CRÉNEAU</div>'
        + '<div style="font-weight:800;margin:5px 0 2px;">' + ech(dem.nom || dem.id) + '</div>'
        + '<div style="font-size:13px;">' + joli(c.date) + ' à ' + ech(c.heure)
        + ' · avec ' + ech(conseiller(c.par).nom) + '</div>'
        + (dem.motif ? '<div style="font-size:13px;margin-top:5px;font-style:italic;">« ' + ech(dem.motif) + ' »</div>' : '')
        + '<div style="display:flex;gap:8px;margin-top:11px;">'
        + '<button class="btn-ok" data-c="' + c._id + '" style="flex:1;padding:10px;border:none;border-radius:9px;background:#38a169;color:#fff;font-weight:800;font-family:inherit;cursor:pointer;">Confirmer</button>'
        + '<button class="btn-non" data-c="' + c._id + '" style="flex:1;padding:10px;border:none;border-radius:9px;background:#e53e3e;color:#fff;font-weight:800;font-family:inherit;cursor:pointer;">Refuser</button>'
        + '</div></div>';
    });

    libres.forEach(function (x) {
      h += '<div style="background:#ebf8ff;border:1px solid #90cdf4;border-radius:12px;padding:14px;margin-bottom:10px;">'
        + '<div style="font-size:11px;font-weight:800;letter-spacing:1px;color:#2c5282;">'
        + (x.type === 'public' ? '🌐 DEMANDE DEPUIS LE SITE' : '💬 DEMANDE LIBRE') + '</div>'
        + '<div style="font-weight:800;margin:5px 0 2px;">' + ech(x.nom || x.qui) + '</div>'
        + '<div style="font-size:13px;">' + ech(x.motif || '') + '</div>'
        // Une demande venue de la vitrine n'a pas de compte : la réponse passe
        // par le téléphone ou le courriel, qu'on affiche donc en clair.
        + (x.type === 'public'
            ? '<div style="font-size:13px;margin-top:4px;">'
              + (x.tel ? '📞 <a href="tel:' + ech(String(x.tel).replace(/\s/g, '')) + '">' + ech(x.tel) + '</a>' : '')
              + (x.email ? ' · ✉️ <a href="mailto:' + ech(x.email) + '">' + ech(x.email) + '</a>' : '')
              + '</div>'
              + '<div style="font-size:12px;margin-top:4px;opacity:.8;">'
              + [x.commune, x.situation, x.age].filter(Boolean).map(ech).join(' · ')
              + '</div>'
            : '')
        + (x.dispo ? '<div style="font-size:13px;margin-top:4px;">Disponibilités : ' + ech(x.dispo) + '</div>' : '')
        + (x.message ? '<div style="font-size:13px;margin-top:4px;font-style:italic;">« ' + ech(x.message) + ' »</div>' : '')
        + '<div style="display:flex;gap:8px;margin-top:11px;">'
        + '<button class="btn-dem-ok" data-d="' + x._id + '" style="flex:1;padding:10px;border:none;border-radius:9px;background:#3182ce;color:#fff;font-weight:800;font-family:inherit;cursor:pointer;">Répondre</button>'
        + '<button class="btn-dem-non" data-d="' + x._id + '" style="flex:1;padding:10px;border:none;border-radius:9px;background:#a0aec0;color:#fff;font-weight:800;font-family:inherit;cursor:pointer;">Classer</button>'
        + '</div></div>';
    });

    refusees.forEach(function (c) {
      h += '<div style="background:#fff5f5;border:1px solid #fc8181;border-radius:12px;padding:14px;margin-bottom:10px;">'
        + '<div style="font-size:11px;font-weight:800;letter-spacing:1px;color:#c53030;">↩️ CONVOCATION DÉCLINÉE</div>'
        + '<div style="font-weight:800;margin:5px 0 2px;">' + ech(c.nom || c.pour) + '</div>'
        + '<div style="font-size:13px;">' + joli(c.date) + ' à ' + ech(c.heure) + '</div>'
        + (c.reponse ? '<div style="font-size:13px;margin-top:5px;font-style:italic;">« ' + ech(c.reponse) + ' »</div>' : '')
        + '<button class="btn-convoc-vu" data-c="' + c._id + '" style="margin-top:10px;padding:8px 14px;border:none;border-radius:9px;background:#718096;color:#fff;font-weight:700;font-family:inherit;font-size:13px;cursor:pointer;">C\'est vu</button>'
        + '</div>';
    });

    return h;
  }

  /* --- Ma semaine --- */
  function vueSemaine(d, role, auj) {
    var occupes = indexOccupes(d.creneaux);
    var bouton = 'flex:1;padding:11px;border:1px dashed #cbd5e0;border-radius:10px;background:#fff;'
      + 'font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;color:#2a3f4e;';
    var h = '<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">'
      + '<button id="rdvExterne" style="' + bouton + '">＋ Rendez-vous (hors appli)</button>'
      + '<button id="rdvPassage" style="' + bouton + '">＋ Passage annoncé</button>'
      + '<button id="rdvCollegue" style="' + bouton + '">＋ RDV pour un collègue</button>'
      + '</div>'
      + '<div id="zoneCollegue"></div>';
    var debut = new Date();
    for (var i = 0; i < 14; i++) {
      var j = new Date(debut); j.setDate(j.getDate() + i);
      var ij = iso(j);
      if (j.getDay() === 0 || j.getDay() === 6) continue;

      // On partage le bureau : on voit aussi ce que le collègue y a prévu.
      var confirmes = d.creneaux.filter(function (c) {
        if (c.date !== ij || c.etat !== 'confirme') return false;
        if (role === 'admin' || c.par === role) return true;
        return BUREAU_PARTAGE.indexOf(role) >= 0 && BUREAU_PARTAGE.indexOf(c.par) >= 0;
      }).sort(function (a, b) { return a.heure.localeCompare(b.heure); });

      var convocs = d.convocations.filter(function (c) {
        return c.date === ij && c.etat === 'accepte' && (role === 'admin' || participe(c.par, role));
      });

      var tous = creneauxDuJour(ij, d.permanences, d.fermetures, occupes, role === 'admin' ? null : role);
      var nbLibres = tous.filter(function (c) { return c.etat === 'libre'; }).length;

      var passages = (d.passages || []).filter(function (x) { return x.date === ij; })
        .sort(function (a, b) { return (a.heure || '').localeCompare(b.heure || ''); });

      if (!confirmes.length && !convocs.length && !tous.length && !passages.length) continue;

      h += '<div style="margin-bottom:12px;">'
        + '<div style="font-size:12px;font-weight:800;letter-spacing:1px;opacity:.6;margin-bottom:5px;">'
        + (ij === auj ? '★ AUJOURD\'HUI — ' : '') + joli(ij).toUpperCase() + '</div>';

      passages.forEach(function (x) {
        h += '<div style="background:#fffaf0;border:1px solid #fbd38d;border-radius:10px;'
          + 'padding:10px 13px;margin-bottom:6px;display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">'
          + '<div><strong style="font-size:13.5px;">'
          + (x.quand === 'apres' ? 'À partir de ' + ech(x.heure) : 'Dans la journée')
          + ' · ' + ech(x.nom) + '</strong>'
          + '<div style="font-size:12px;opacity:.75;margin-top:2px;">'
          + 'Pour ' + ech(conseiller(x.par).nom.split(' ')[0])
          + (x.motif ? ' · ' + ech(x.motif) : '')
          + (x.tel ? ' · 📞 ' + ech(x.tel) : '') + '</div>'
          + '<div style="font-size:11px;opacity:.55;margin-top:3px;">Sans horaire ferme — le bureau n\'est pas bloqué</div>'
          + '</div>'
          + '<button class="btn-passage-suppr" data-x="' + x._id + '" style="border:none;background:none;font-size:17px;cursor:pointer;color:#a0aec0;">✕</button>'
          + '</div>';
      });

      if (!confirmes.length && !convocs.length) {
        h += '<div style="font-size:13px;opacity:.5;padding:8px 12px;background:#f7fafc;border-radius:9px;">'
          + 'Aucun rendez-vous · ' + nbLibres + ' créneau' + (nbLibres > 1 ? 'x' : '') + ' libre'
          + (nbLibres > 1 ? 's' : '') + '</div>';
      }

      confirmes.forEach(function (c) {
        var dem = c.demandeur || {};
        var auCollegue = role !== 'admin' && c.par !== role;
        h += '<div style="background:' + (auCollegue ? '#f7fafc' : '#fff') + ';border:1px solid #e2e8f0;border-left:4px solid ' + conseiller(c.par).couleur + ';'
          + 'border-radius:0 10px 10px 0;padding:11px 13px;margin-bottom:6px;">'
          + '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;">'
          + '<strong>' + ech(c.heure) + ' · ' + ech(dem.nom || dem.id)
          + (dem.type === 'ext' ? ' <span style="font-size:10px;font-weight:800;letter-spacing:1px;'
              + 'background:#edf2f7;color:#4a5568;border-radius:5px;padding:2px 6px;">HORS APPLI</span>' : '')
          + '</strong>'
          + '<span style="font-size:11px;opacity:.6;">'
          + (auCollegue ? 'bureau occupé · ' : '') + ech(conseiller(c.par).nom.split(' ')[0]) + '</span></div>'
          + (dem.motif ? '<div style="font-size:12.5px;opacity:.8;margin-top:3px;">' + ech(dem.motif) + '</div>' : '')
          + (dem.tel ? '<div style="font-size:12.5px;opacity:.7;margin-top:2px;">📞 ' + ech(dem.tel) + '</div>' : '')
          + (auCollegue ? ''
              : '<div style="display:flex;gap:7px;margin-top:8px;">'
              + '<button class="btn-reporter" data-c="' + c._id + '" style="padding:6px 12px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;font-size:12px;font-family:inherit;cursor:pointer;">Reporter</button>'
              + '<button class="btn-annuler-eq" data-c="' + c._id + '" style="padding:6px 12px;border:1px solid #fed7d7;border-radius:8px;background:#fff;color:#c53030;font-size:12px;font-family:inherit;cursor:pointer;">Annuler</button>'
              + '</div>')
          + '</div>';
      });

      convocs.forEach(function (c) {
        h += '<div style="background:#fff;border:1px solid #e2e8f0;border-left:4px solid #38a169;'
          + 'border-radius:0 10px 10px 0;padding:11px 13px;margin-bottom:6px;">'
          + '<strong>' + ech(c.heure) + ' · ' + ech(c.nom || c.pour) + '</strong>'
          + '<div style="font-size:12px;opacity:.65;">Convocation acceptée</div></div>';
      });

      h += '</div>';
    }
    return h || '<div style="text-align:center;padding:34px;opacity:.55;">Rien de prévu sur les deux prochaines semaines.</div>';
  }

  /* --- Mes permanences --- */
  function vuePermanences(d, moiSeul) {
    var mienne = d.permanences.filter(function (p) { return !moiSeul || p.par === moiSeul; });
    var auj = isoAujourdhui();
    var ferm = d.fermetures.filter(function (f) {
      return f.date >= auj && (!moiSeul || f.par === moiSeul || f.par === '*');
    }).sort(function (a, b) { return a.date.localeCompare(b.date); });

    var h = '<div style="background:var(--or-pale,#fdf6e3);border-left:4px solid var(--or,#C9A227);'
      + 'border-radius:0 10px 10px 0;padding:12px 15px;font-size:13px;line-height:1.6;margin-bottom:14px;color:#5a4510;">'
      + 'Une permanence se répète <strong>toutes les semaines</strong>, toute l\'année. '
      + 'Vous ne publiez plus rien : vous fermez seulement les jours où vous n\'êtes pas là.'
      + '</div>';

    h += '<div style="font-size:12px;font-weight:800;letter-spacing:1px;opacity:.6;margin-bottom:7px;">MES PERMANENCES</div>';
    if (!mienne.length) {
      h += '<div style="font-size:13px;opacity:.6;padding:12px;background:#f7fafc;border-radius:9px;margin-bottom:12px;">'
        + 'Aucune permanence déclarée. Aucun créneau n\'est proposé aux apprenants.</div>';
    }
    mienne.forEach(function (p) {
      var nb = casesDe(p).length;
      h += '<div style="background:#fff;border:1px solid #e2e8f0;border-left:4px solid ' + conseiller(p.par).couleur + ';'
        + 'border-radius:0 10px 10px 0;padding:12px 14px;margin-bottom:8px;' + (p.actif === false ? 'opacity:.5;' : '') + '">'
        + '<div style="font-weight:800;">Tous les ' + JOURS[p.jour].toLowerCase() + 's · ' + ech(p.debut) + ' → ' + ech(p.fin) + '</div>'
        + '<div style="font-size:12.5px;opacity:.75;margin-top:2px;">'
        + nb + ' créneau' + (nb > 1 ? 'x' : '') + ' de ' + p.duree + ' min · ' + ech(conseiller(p.par).nom)
        + '</div>'
        + '<div style="font-size:12px;opacity:.6;margin-top:2px;">' + ech(p.lieu || LIEU_DEFAUT) + '</div>'
        + '<div style="display:flex;gap:7px;margin-top:9px;">'
        + '<button class="btn-perm-bascule" data-p="' + p._id + '" style="padding:6px 12px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;font-size:12px;font-family:inherit;cursor:pointer;">'
        + (p.actif === false ? 'Réactiver' : 'Suspendre') + '</button>'
        + '<button class="btn-perm-suppr" data-p="' + p._id + '" style="padding:6px 12px;border:1px solid #fed7d7;border-radius:8px;background:#fff;color:#c53030;font-size:12px;font-family:inherit;cursor:pointer;">Supprimer</button>'
        + '</div></div>';
    });

    h += '<button id="permAjout" style="width:100%;padding:12px;border:1px dashed #cbd5e0;border-radius:10px;'
      + 'background:#fff;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;color:#2a3f4e;margin-bottom:20px;">'
      + '＋ Ajouter une permanence</button>';

    h += '<div style="font-size:12px;font-weight:800;letter-spacing:1px;opacity:.6;margin-bottom:7px;">JOURS FERMÉS À VENIR</div>';
    if (!ferm.length) {
      h += '<div style="font-size:13px;opacity:.6;padding:12px;background:#f7fafc;border-radius:9px;margin-bottom:12px;">'
        + 'Aucune fermeture prévue. Les jours fériés sont déjà exclus automatiquement.</div>';
    }
    ferm.forEach(function (f) {
      h += '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;background:#fff;'
        + 'border:1px solid #e2e8f0;border-radius:10px;padding:10px 13px;margin-bottom:6px;">'
        + '<div><strong style="font-size:13.5px;">' + joli(f.date) + (f.heure ? ' à ' + ech(f.heure) : ' — journée') + '</strong>'
        + '<div style="font-size:12px;opacity:.65;">' + (f.par === '*' ? 'Toute l\'équipe' : ech(conseiller(f.par).nom))
        + (f.motif ? ' · ' + ech(f.motif) : '') + '</div></div>'
        + '<button class="btn-ferm-suppr" data-f="' + f._id + '" style="border:none;background:none;font-size:17px;cursor:pointer;color:#a0aec0;">✕</button>'
        + '</div>';
    });

    h += '<button id="fermAjout" style="width:100%;padding:12px;border:1px dashed #cbd5e0;border-radius:10px;'
      + 'background:#fff;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;color:#2a3f4e;">'
      + '＋ Fermer une date</button>';

    return h;
  }

  /* --- Convoquer --- */
  async function vueConvoquer(d, role) {
    await chargerAnnuaire();
    var auj = isoAujourdhui();
    var enCours = d.convocations.filter(function (c) {
      return c.date >= auj && c.etat !== 'annule' && (role === 'admin' || participe(c.par, role));
    }).sort(function (a, b) { return (a.date + a.heure).localeCompare(b.date + b.heure); });

    var h = '<button id="convocNouvelle" style="width:100%;padding:13px;border:none;border-radius:10px;'
      + 'background:var(--bleu-fonce,#2a3f4e);color:#fff;font-family:inherit;font-size:14px;font-weight:800;'
      + 'cursor:pointer;margin-bottom:14px;">📨 Proposer un rendez-vous à quelqu\'un</button>';

    if (!enCours.length) {
      h += '<div style="text-align:center;padding:26px;opacity:.55;font-size:14px;">Aucune convocation en cours.</div>';
      return h;
    }

    enCours.forEach(function (c) {
      var etats = {
        propose: ['⏳ EN ATTENTE DE RÉPONSE', '#975a16', '#fffaf0', '#fbd38d'],
        accepte: ['✅ ACCEPTÉE', '#276749', '#f0fff4', '#9ae6b4'],
        refuse:  ['↩️ DÉCLINÉE', '#c53030', '#fff5f5', '#fc8181']
      };
      var e = etats[c.etat] || etats.propose;
      h += '<div style="background:' + e[2] + ';border:1px solid ' + e[3] + ';border-radius:12px;padding:13px;margin-bottom:9px;">'
        + '<div style="font-size:11px;font-weight:800;letter-spacing:1px;color:' + e[1] + ';">' + e[0] + '</div>'
        + '<div style="font-weight:800;margin:4px 0 2px;">' + ech(c.nom || c.pour) + '</div>'
        + '<div style="font-size:13px;">' + joli(c.date) + ' à ' + ech(c.heure) + '</div>'
        + (c.reponse ? '<div style="font-size:13px;margin-top:5px;font-style:italic;">« ' + ech(c.reponse) + ' »</div>' : '')
        + '<button class="btn-convoc-suppr" data-c="' + c._id + '" style="margin-top:9px;padding:7px 13px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;font-size:12px;font-family:inherit;cursor:pointer;color:#718096;">Retirer</button>'
        + '</div>';
    });
    return h;
  }

  /* --- Les actions de l'équipe --- */
  function brancherEquipe(boite, role) {
    boite.querySelectorAll('.rdv-onglet').forEach(function (b) {
      b.addEventListener('click', function () { vue = b.getAttribute('data-v'); rendreEquipe(boite, role); });
    });

    boite.querySelectorAll('.btn-ok').forEach(function (b) {
      b.addEventListener('click', async function () {
        var k = b.getAttribute('data-c');
        await api.ecrire('creneaux/' + k + '/etat', 'confirme');
        await api.ecrire('creneaux/' + k + '/repondu', new Date().toISOString());
        await api.ecrire('creneaux/' + k + '/traitePar', role);
        await api.ecrire('creneaux/' + k + '/notifieReponse', false);
        rendreEquipe(boite, role);
      });
    });

    boite.querySelectorAll('.btn-non').forEach(function (b) {
      b.addEventListener('click', async function () {
        var msg = prompt('Refuser ce créneau.\n\nQue souhaitez-vous dire à la personne ?',
          'Ce créneau n\'est finalement pas disponible. Choisissez-en un autre, ou dites-nous vos disponibilités.');
        if (msg === null) return;
        var k = b.getAttribute('data-c');
        await api.ecrire('creneaux/' + k + '/etat', 'refuse');
        await api.ecrire('creneaux/' + k + '/reponse', msg.trim());
        await api.ecrire('creneaux/' + k + '/repondu', new Date().toISOString());
        await api.ecrire('creneaux/' + k + '/traitePar', role);
        await api.ecrire('creneaux/' + k + '/notifieReponse', false);
        rendreEquipe(boite, role);
      });
    });

    boite.querySelectorAll('.btn-annuler-eq').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Annuler ce rendez-vous ?\n\nLe créneau redeviendra libre.')) return;
        await api.ecrire('creneaux/' + b.getAttribute('data-c'), null);
        rendreEquipe(boite, role);
      });
    });

    boite.querySelectorAll('.btn-reporter').forEach(function (b) {
      b.addEventListener('click', function () { reporter(b.getAttribute('data-c'), boite, role); });
    });

    boite.querySelectorAll('.btn-dem-ok').forEach(function (b) {
      b.addEventListener('click', function () {
        var did = b.getAttribute('data-d');
        formulaire('Proposer une date', [
          { id:'date', label:'Date', type:'date', requis:true, valeur:isoAujourdhui(), min:isoAujourdhui() },
          { id:'heure', label:'Heure', type:'select', requis:true, valeur:'14:00', options:optionsHeures() },
          { id:'mot', label:'Un mot à ajouter (facultatif)', type:'textarea' }
        ], async function (v) {
          var quand = joli(v.date) + ' à ' + v.heure;
          await api.ecrire('rdvDemandes/' + did + '/etat', 'confirme');
          await api.ecrire('rdvDemandes/' + did + '/quand', quand);
          await api.ecrire('rdvDemandes/' + did + '/reponse',
            'Rendez-vous proposé : ' + quand + (v.mot ? ' — ' + v.mot : ''));
          rendreEquipe(boite, role);
        });
      });
    });

    boite.querySelectorAll('.btn-dem-non').forEach(function (b) {
      b.addEventListener('click', async function () {
        var msg = prompt('Message à la personne :', '');
        if (msg === null) return;
        var did = b.getAttribute('data-d');
        await api.ecrire('rdvDemandes/' + did + '/etat', 'refuse');
        await api.ecrire('rdvDemandes/' + did + '/reponse', msg.trim());
        rendreEquipe(boite, role);
      });
    });

    boite.querySelectorAll('.btn-convoc-vu').forEach(function (b) {
      b.addEventListener('click', async function () {
        await api.ecrire('convocations/' + b.getAttribute('data-c') + '/etat', 'annule');
        rendreEquipe(boite, role);
      });
    });
    boite.querySelectorAll('.btn-convoc-suppr').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Retirer cette convocation ?')) return;
        await api.ecrire('convocations/' + b.getAttribute('data-c'), null);
        rendreEquipe(boite, role);
      });
    });

    var pa = boite.querySelector('#permAjout');
    if (pa) pa.addEventListener('click', function () { ajouterPermanence(boite, role); });
    boite.querySelectorAll('.btn-perm-suppr').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Supprimer cette permanence ?\n\nLes rendez-vous déjà confirmés sont conservés.')) return;
        await api.ecrire('permanences/' + b.getAttribute('data-p'), null);
        rendreEquipe(boite, role);
      });
    });
    boite.querySelectorAll('.btn-perm-bascule').forEach(function (b) {
      b.addEventListener('click', async function () {
        var p = await api.lire('permanences/' + b.getAttribute('data-p'));
        await api.ecrire('permanences/' + b.getAttribute('data-p') + '/actif', !(p && p.actif !== false));
        rendreEquipe(boite, role);
      });
    });

    var fa = boite.querySelector('#fermAjout');
    if (fa) fa.addEventListener('click', function () { ajouterFermeture(boite, role); });
    boite.querySelectorAll('.btn-ferm-suppr').forEach(function (b) {
      b.addEventListener('click', async function () {
        await api.ecrire('fermetures/' + b.getAttribute('data-f'), null);
        rendreEquipe(boite, role);
      });
    });

    var cn = boite.querySelector('#convocNouvelle');
    if (cn) cn.addEventListener('click', function () { nouvelleConvocation(boite, role); });

    var ext = boite.querySelector('#rdvExterne');
    if (ext) ext.addEventListener('click', function () { noterRendezVous(boite, role); });

    var pas = boite.querySelector('#rdvPassage');
    if (pas) pas.addEventListener('click', function () { annoncerPassage(boite, role); });

    var col = boite.querySelector('#rdvCollegue');
    if (col) col.addEventListener('click', function () { pourUnCollegue(boite, role); });
    boite.querySelectorAll('.btn-passage-suppr').forEach(function (b) {
      b.addEventListener('click', async function () {
        await api.ecrire('passages/' + b.getAttribute('data-x'), null);
        rendreEquipe(boite, role);
      });
    });
  }

  /* Un rendez-vous avec quelqu'un qui n'est pas dans l'application :
     candidat reçu en information, partenaire, ancien apprenant, famille.
     On l'enregistre comme les autres — il bloque donc le créneau, apparaît
     dans « Ma semaine » et dans l'agenda du matin. Aucun courriel ne part :
     cette personne n'a pas de compte.                                       */
  async function noterRendezVous(boite, role) {
    formulaire('Noter un rendez-vous', [
      { id:'par', label:'Pour qui', type:'select', options:optionsConseillers(role),
        valeur:(role !== 'admin' ? role : 'AB') },
      { id:'nom', label:'Nom de la personne recue', type:'text', requis:true, aide:'Madame Payet' },
      { id:'date', label:'Date', type:'date', requis:true, valeur:isoAujourdhui(), min:isoAujourdhui() },
      { id:'heure', label:'Heure', type:'select', requis:true, valeur:'14:00', options:optionsHeures() },
      { id:'duree', label:'Duree', type:'select', valeur:'30',
        options:[['15','15 minutes'],['30','30 minutes'],['45','45 minutes'],
                 ['60','1 heure'],['90','1 h 30'],['120','2 heures']] },
      { id:'motif', label:'Motif', type:'text', valeur:'Information / premier contact' },
      { id:'tel', label:'Telephone (facultatif)', type:'tel', aide:'06 92 ...' }
    ], async function (v) {
      var k = cle(v.par, v.date, v.heure);
      var deja = await api.lire('creneaux/' + k);
      if (deja && (deja.etat === 'demande' || deja.etat === 'confirme')) {
        var occ = (deja.demandeur && deja.demandeur.nom) || 'quelqu\'un';
        throw new Error('ce creneau est deja pris par ' + occ);
      }
      await api.ecrire('creneaux/' + k, {
        par: v.par, date: v.date, heure: v.heure, duree: parseInt(v.duree, 10) || 30,
        lieu: LIEU_DEFAUT, etat: 'confirme',
        demandeur: {
          id: 'ext_' + Date.now().toString(36), nom: v.nom, type: 'ext',
          motif: v.motif, tel: v.tel, le: new Date().toISOString()
        },
        reponse: '', repondu: new Date().toISOString(), traitePar: role,
        notifie: true, notifieReponse: true
      });
      rendreEquipe(boite, role);
    });
  }


  /* == UN VRAI FORMULAIRE, PLUTOT QUE DES FENETRES GRISES ==================
     Les dates tapees a la main sont la premiere source d'erreur : 12/10/26,
     2026-10-12, 12 octobre... Ici, un calendrier et des listes deroulantes.  */

  function heuresPossibles(debut, fin, pas) {
    var out = [], d = minutes(debut || '07:00'), f = minutes(fin || '19:00');
    for (var t = d; t <= f; t += (pas || 15)) out.push(heureDe(t));
    return out;
  }

  function optionsHeures() {
    return heuresPossibles('07:00', '19:00', 15).map(function (h) { return [h, h]; });
  }

  function champHTML(c) {
    var base = 'width:100%;padding:10px 12px;border:1px solid #cbd5e0;border-radius:9px;'
             + 'font-family:inherit;font-size:14px;color:#2a3f4e;background:#fff;box-sizing:border-box;';
    var h = '<div style="margin-bottom:11px;" data-champ="' + c.id + '">'
          + '<label style="display:block;font-size:11px;font-weight:800;letter-spacing:.5px;'
          + 'text-transform:uppercase;opacity:.6;margin-bottom:4px;">' + ech(c.label) + '</label>';

    if (c.type === 'select') {
      h += '<select id="f_' + c.id + '" style="' + base + '">'
        + (c.options || []).map(function (o) {
            return '<option value="' + ech(o[0]) + '"'
                 + (String(o[0]) === String(c.valeur) ? ' selected' : '') + '>' + ech(o[1]) + '</option>';
          }).join('')
        + '</select>';
    } else if (c.type === 'textarea') {
      h += '<textarea id="f_' + c.id + '" rows="2" placeholder="' + ech(c.aide || '') + '" style="' + base
        + 'resize:vertical;">' + ech(c.valeur || '') + '</textarea>';
    } else {
      h += '<input id="f_' + c.id + '" type="' + (c.type || 'text') + '" '
        + 'value="' + ech(c.valeur || '') + '" placeholder="' + ech(c.aide || '') + '" '
        + (c.type === 'date' && c.min ? 'min="' + c.min + '" ' : '')
        + 'style="' + base + '">';
    }
    return h + '</div>';
  }

  /* Ouvre le formulaire et appelle onOk(valeurs) si l'utilisateur valide. */
  function formulaire(titre, champs, onOk) {
    var fond = document.createElement('div');
    fond.style.cssText = 'position:fixed;inset:0;background:rgba(20,28,36,.55);z-index:9000;'
      + 'display:flex;align-items:flex-start;justify-content:center;padding:24px 14px;overflow:auto;';

    var carte = document.createElement('div');
    carte.style.cssText = 'background:#fff;border-radius:16px;padding:20px;width:100%;max-width:420px;'
      + 'box-shadow:0 20px 60px rgba(0,0,0,.3);font-family:inherit;color:#2a3f4e;';

    carte.innerHTML =
      '<div style="font-size:17px;font-weight:800;margin-bottom:14px;line-height:1.35;">' + ech(titre) + '</div>'
      + champs.map(champHTML).join('')
      + '<div style="display:flex;gap:9px;margin-top:16px;">'
      + '<button id="fAnnuler" style="flex:1;padding:12px;border:1px solid #e2e8f0;border-radius:10px;'
      + 'background:#fff;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;color:#718096;">Annuler</button>'
      + '<button id="fValider" style="flex:2;padding:12px;border:none;border-radius:10px;'
      + 'background:#2a3f4e;color:#fff;font-family:inherit;font-size:14px;font-weight:800;cursor:pointer;">Valider</button>'
      + '</div>'
      + '<div id="fErreur" style="display:none;margin-top:10px;background:#fff5f5;border:1px solid #fed7d7;'
      + 'color:#c53030;border-radius:9px;padding:9px 12px;font-size:12.5px;font-weight:600;"></div>';

    fond.appendChild(carte);
    document.body.appendChild(fond);

    function fermer() { if (fond.parentNode) document.body.removeChild(fond); }
    fond.addEventListener('click', function (e) { if (e.target === fond) fermer(); });
    carte.querySelector('#fAnnuler').addEventListener('click', fermer);

    // Les champs qui n'ont de sens que si un autre a une certaine valeur.
    function ajuster() {
      champs.forEach(function (c) {
        if (!c.sauf) return;
        var pilote = carte.querySelector('#f_' + c.sauf.champ);
        var zone = carte.querySelector('[data-champ="' + c.id + '"]');
        if (pilote && zone) zone.style.display = (pilote.value === c.sauf.vaut) ? '' : 'none';
      });
    }
    champs.forEach(function (c) {
      if (!c.sauf) return;
      var pilote = carte.querySelector('#f_' + c.sauf.champ);
      if (pilote) pilote.addEventListener('change', ajuster);
    });
    ajuster();

    var premier = carte.querySelector('input, select');
    if (premier) premier.focus();

    carte.querySelector('#fValider').addEventListener('click', async function () {
      var bouton = this;
      var v = {};
      champs.forEach(function (c) {
        var el = carte.querySelector('#f_' + c.id);
        v[c.id] = el ? String(el.value || '').trim() : '';
      });

      var vide = champs.filter(function (c) {
        if (!c.requis) return false;
        var zone = carte.querySelector('[data-champ="' + c.id + '"]');
        if (zone && zone.style.display === 'none') return false;
        return !v[c.id];
      });
      if (vide.length) {
        var e = carte.querySelector('#fErreur');
        e.textContent = 'A completer : ' + vide.map(function (c) { return c.label.toLowerCase(); }).join(', ');
        e.style.display = 'block';
        return;
      }

      bouton.disabled = true; bouton.textContent = 'Enregistrement...';
      try { await onOk(v); fermer(); }
      catch (err) {
        bouton.disabled = false; bouton.textContent = 'Valider';
        var e2 = carte.querySelector('#fErreur');
        e2.textContent = 'Impossible : ' + (err && err.message ? err.message : 'erreur inattendue');
        e2.style.display = 'block';
      }
    });
  }

  // Les conseillers proposes, celui qui est connecte en tete.
  function optionsConseillers(role, avecEquipe) {
    var l = Object.keys(CONSEILLERS).map(function (c) { return [c, CONSEILLERS[c].nom]; });
    if (role !== 'admin') l.sort(function (a, b) { return (b[0] === role) - (a[0] === role); });
    if (avecEquipe) l.unshift(['*', 'Toute l\'equipe']);
    return l;
  }

  /* LA PORTE D'ENTRÉE
     Quelqu'un se présente au centre, le CIP concerné n'est pas là.
     Emilie (ou n'importe qui de l'équipe) voit les créneaux libres des autres
     et en réserve un. Cela part comme une DEMANDE : le créneau est bloqué,
     le collègue reçoit un courriel, et c'est lui qui confirme.              */
  async function pourUnCollegue(boite, role) {
    var zone = boite.querySelector('#zoneCollegue');
    if (!zone) return;
    zone.innerHTML = '<div style="opacity:.6;font-size:13px;padding:10px;">Recherche des créneaux libres…</div>';

    var d = await chargerTout();
    var occupes = indexOccupes(d.creneaux);
    var libres = [];
    var jour = new Date();

    // On regarde trois semaines : au-delà, on prend rendez-vous autrement.
    for (var i = 0; i < 21 && libres.length < 18; i++) {
      var ij = iso(jour);
      creneauxDuJour(ij, d.permanences, d.fermetures, occupes).forEach(function (c) {
        if (c.etat !== 'libre') return;
        if (c.par === role) return;          // pour un COLLÈGUE, pas pour soi
        libres.push(c);
      });
      jour.setDate(jour.getDate() + 1);
    }

    if (!libres.length) {
      zone.innerHTML = '<div style="background:#fffaf0;border:1px solid #fbd38d;border-radius:10px;'
        + 'padding:12px 15px;font-size:13px;line-height:1.6;">'
        + 'Aucun créneau libre chez vos collègues dans les trois prochaines semaines.<br>'
        + 'Notez plutôt un <strong>passage annoncé</strong>, ou appelez-les.'
        + '</div>';
      return;
    }

    var h = '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:14px;">'
      + '<div style="font-size:12px;font-weight:800;letter-spacing:1px;opacity:.6;margin-bottom:4px;">'
      + 'CRÉNEAUX LIBRES DE VOS COLLÈGUES</div>'
      + '<div style="font-size:12.5px;opacity:.75;line-height:1.6;margin-bottom:10px;">'
      + 'Choisissez une heure. Votre collègue recevra la demande et confirmera — '
      + 'en attendant, le créneau est bloqué.</div>'
      + '<div style="display:flex;flex-direction:column;gap:6px;max-height:300px;overflow:auto;">';

    var dernierJour = '';
    libres.forEach(function (c) {
      if (c.date !== dernierJour) {
        dernierJour = c.date;
        h += '<div style="font-size:11px;font-weight:800;letter-spacing:1px;opacity:.5;margin-top:6px;">'
          + joli(c.date).toUpperCase() + '</div>';
      }
      h += '<button class="btn-libre" data-p="' + c.par + '" data-d="' + c.date + '" data-h="' + c.heure + '"'
        + ' style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 13px;'
        + 'border:1px solid ' + conseiller(c.par).couleur + ';border-radius:9px;background:#fff;'
        + 'font-family:inherit;font-size:13.5px;font-weight:700;cursor:pointer;text-align:left;'
        + 'color:' + conseiller(c.par).couleur + ';">'
        + '<span>' + c.heure + '</span>'
        + '<span style="font-weight:600;opacity:.8;">' + ech(conseiller(c.par).nom) + '</span></button>';
    });

    h += '</div><button id="fermerLibres" style="margin-top:10px;padding:8px 14px;border:1px solid #e2e8f0;'
      + 'border-radius:8px;background:#fff;font-size:12px;font-family:inherit;cursor:pointer;color:#718096;">'
      + 'Fermer</button></div>';

    zone.innerHTML = h;

    zone.querySelector('#fermerLibres').addEventListener('click', function () { zone.innerHTML = ''; });
    zone.querySelectorAll('.btn-libre').forEach(function (b) {
      b.addEventListener('click', function () {
        reserverPourCollegue(b.getAttribute('data-p'), b.getAttribute('data-d'),
                             b.getAttribute('data-h'), boite, role);
      });
    });
  }

  async function reserverPourCollegue(par, date, heure, boite, role) {
    formulaire('Rendez-vous avec ' + conseiller(par).nom + ' - ' + joli(date) + ' a ' + heure, [
      { id:'nom', label:'Nom de la personne recue', type:'text', requis:true },
      { id:'motif', label:'Motif de la visite', type:'text', requis:true },
      { id:'tel', label:'Telephone (facultatif)', type:'tel' }
    ], async function (v) {
      var k = cle(par, date, heure);
      var deja = await api.lire('creneaux/' + k);
      if (deja && (deja.etat === 'demande' || deja.etat === 'confirme')) {
        throw new Error('ce creneau vient d\'etre pris');
      }

      var perms = objetVersListe(await api.lire('permanences'));
      var j = dateDe(date).getDay();
      var p = perms.filter(function (x) { return x.par === par && x.jour === j && x.actif !== false; })[0] || {};

      await api.ecrire('creneaux/' + k, {
        par: par, date: date, heure: heure,
        duree: p.duree || 30, lieu: p.lieu || LIEU_DEFAUT,
        etat: 'demande',
        demandeur: {
          id: 'ext_' + Date.now().toString(36), nom: v.nom, type: 'ext',
          motif: 'Note par ' + conseiller(role).nom.split(' ')[0] + ' - ' + v.motif,
          tel: v.tel, le: new Date().toISOString()
        },
        reponse: '', repondu: '', traitePar: '',
        notifie: false, notifieReponse: true
      });
      rendreEquipe(boite, role);
    });
  }

  /* Quelqu'un passe « dans la journée » ou « à partir de 14h ».
     On ne bloque rien — l'horaire n'est pas ferme — mais l'information est
     visible par toute l'équipe, ce qui est l'essentiel quand on partage un
     bureau.                                                                  */
  async function annoncerPassage(boite, role) {
    formulaire('Annoncer un passage', [
      { id:'par', label:'Qui doit la recevoir', type:'select', options:optionsConseillers(role),
        valeur:(role !== 'admin' ? role : 'AB') },
      { id:'nom', label:'Nom de la personne', type:'text', requis:true, aide:'Madame Cillon' },
      { id:'date', label:'Jour', type:'date', requis:true, valeur:isoAujourdhui(), min:isoAujourdhui() },
      { id:'quand', label:'Quand', type:'select', valeur:'jour',
        options:[['jour','Dans la journee, sans heure'],['apres','A partir d\'une heure precise']] },
      { id:'heure', label:'A partir de', type:'select', valeur:'14:00',
        sauf:{ champ:'quand', vaut:'apres' }, options:optionsHeures() },
      { id:'motif', label:'Motif (facultatif)', type:'text' },
      { id:'tel', label:'Telephone (facultatif)', type:'tel' }
    ], async function (v) {
      await api.ecrire('passages/' + id('x'), {
        par: v.par, date: v.date,
        quand: v.quand, heure: v.quand === 'apres' ? v.heure : '',
        nom: v.nom, motif: v.motif, tel: v.tel,
        note: role, le: new Date().toISOString()
      });
      rendreEquipe(boite, role);
    });
  }

  async function reporter(k, boite, role) {
    var c = await api.lire('creneaux/' + k);
    if (!c) return;
    var dem = c.demandeur || {};

    formulaire('Reporter le rendez-vous de ' + (dem.nom || ''), [
      { id:'date', label:'Nouvelle date', type:'date', requis:true, valeur:c.date, min:isoAujourdhui() },
      { id:'heure', label:'Nouvelle heure', type:'select', requis:true, valeur:c.heure, options:optionsHeures() }
    ], async function (v) {
      var nk = cle(c.par, v.date, v.heure);
      if (nk !== k) {
        var deja = await api.lire('creneaux/' + nk);
        if (deja && (deja.etat === 'demande' || deja.etat === 'confirme')) {
          throw new Error('ce nouveau creneau est deja occupe');
        }
      }
      c.date = v.date; c.heure = v.heure;
      c.etat = 'confirme'; c.repondu = new Date().toISOString();
      c.notifieReponse = false; c.reporte = true;
      await api.ecrire('creneaux/' + nk, c);
      if (nk !== k) await api.ecrire('creneaux/' + k, null);
      rendreEquipe(boite, role);
    });
  }

  async function ajouterPermanence(boite, role) {
    formulaire('Ajouter une permanence', [
      { id:'par', label:'Pour qui', type:'select', options:optionsConseillers(role),
        valeur:(role !== 'admin' ? role : 'AB') },
      { id:'jour', label:'Jour de la semaine', type:'select', valeur:'2',
        options:[['1','Tous les lundis'],['2','Tous les mardis'],['3','Tous les mercredis'],
                 ['4','Tous les jeudis'],['5','Tous les vendredis']] },
      { id:'debut', label:'De', type:'select', valeur:'14:00', options:optionsHeures() },
      { id:'fin', label:'A', type:'select', valeur:'16:00', options:optionsHeures() },
      { id:'duree', label:'Duree d\'un rendez-vous', type:'select', valeur:'30',
        options:[['15','15 minutes'],['20','20 minutes'],['30','30 minutes'],
                 ['45','45 minutes'],['60','1 heure']] },
      { id:'lieu', label:'Lieu', type:'text', valeur:LIEU_DEFAUT }
    ], async function (v) {
      if (minutes(v.fin) <= minutes(v.debut)) throw new Error('l\'heure de fin doit suivre celle de debut');
      var duree = parseInt(v.duree, 10);
      var nb = Math.floor((minutes(v.fin) - minutes(v.debut)) / duree);
      if (!nb) throw new Error('la plage est trop courte pour un creneau de ' + duree + ' minutes');

      await api.ecrire('permanences/' + id('p'), {
        par: v.par, jour: parseInt(v.jour, 10), debut: v.debut, fin: v.fin, duree: duree,
        lieu: v.lieu || LIEU_DEFAUT, actif: true,
        depuis: isoAujourdhui(), jusqua: '', le: new Date().toISOString()
      });
      rendreEquipe(boite, role);
    });
  }

  async function ajouterFermeture(boite, role) {
    formulaire('Fermer une date', [
      { id:'par', label:'Pour qui', type:'select', options:optionsConseillers(role, true),
        valeur:(role !== 'admin' ? role : '*') },
      { id:'date', label:'Date a fermer', type:'date', requis:true, valeur:isoAujourdhui(), min:isoAujourdhui() },
      { id:'portee', label:'Etendue', type:'select', valeur:'jour',
        options:[['jour','Toute la journee'],['heure','Un seul creneau']] },
      { id:'heure', label:'Creneau concerne', type:'select', valeur:'14:00',
        sauf:{ champ:'portee', vaut:'heure' }, options:optionsHeures() },
      { id:'motif', label:'Motif (facultatif)', type:'text', aide:'Deplacement, reunion...' }
    ], async function (v) {
      await api.ecrire('fermetures/' + id('f'), {
        par: v.par, date: v.date,
        heure: v.portee === 'heure' ? v.heure : '',
        motif: v.motif, le: new Date().toISOString()
      });
      rendreEquipe(boite, role);
    });
  }

  async function nouvelleConvocation(boite, role) {
    await chargerAnnuaire();
    var qui = annuaire.map(function (a) {
      var t = a.type === 'fc' ? 'formation continue' : (a.type === 'stg' ? 'stage' : 'alternance');
      return [a.id, a.nom + ' - ' + t];
    });
    if (!qui.length) { alert('Aucun apprenant enregistre.'); return; }

    formulaire('Proposer un rendez-vous', [
      { id:'pour', label:'A qui', type:'select', options:qui, requis:true },
      { id:'par', label:'De la part de', type:'select', options:optionsConseillers(role),
        valeur:(role !== 'admin' ? role : 'AB') },
      { id:'date', label:'Date proposee', type:'date', requis:true, valeur:isoAujourdhui(), min:isoAujourdhui() },
      { id:'heure', label:'Heure', type:'select', requis:true, valeur:'14:00', options:optionsHeures() },
      { id:'motif', label:'Motif', type:'select', valeur:MOTIFS[0],
        options:MOTIFS.map(function (m) { return [m, m]; }) },
      { id:'message', label:'Un mot a ajouter (facultatif)', type:'textarea',
        aide:'Ce que vous voulez lui dire avant le rendez-vous' }
    ], async function (v) {
      var cible = annuaire.filter(function (a) { return a.id === v.pour; })[0];
      if (!cible) throw new Error('personne introuvable');

      await api.ecrire('convocations/' + id('v'), {
        pour: cible.id, type: cible.type, nom: cible.nom,
        par: v.par, date: v.date, heure: v.heure,
        motif: v.motif, message: v.message, lieu: LIEU_DEFAUT,
        etat: 'propose', reponse: '', repondu: '',
        le: new Date().toISOString(), notifie: false, notifieReponse: true
      });
      rendreEquipe(boite, role);
    });
  }

  /* ---- Pastille de l'onglet ----------------------------------------------- */

  async function nombreEnAttente(role) {
    var lots = await Promise.all([
      api.lire('creneaux'), api.lire('rdvDemandes'), api.lire('convocations')
    ]);
    var auj = isoAujourdhui();

    var n = objetVersListe(lots[0]).filter(function (c) {
      return c.etat === 'demande' && c.date >= auj && (role === 'admin' || c.par === role);
    }).length;

    n += objetVersListe(lots[1]).filter(function (d) {
      if (d.etat !== 'demande') return false;
      if (role === 'admin') return true;
      if (d.avec === '?') return true;
      return participe(d.avec, role);
    }).length;

    n += objetVersListe(lots[2]).filter(function (c) {
      if (c.etat !== 'refuse') return false;
      return role === 'admin' || participe(c.par, role);
    }).length;

    return n;
  }

  /* ---- Ce que les pages utilisent ----------------------------------------- */

  global.JTCF_RDV = {
    CONSEILLERS: CONSEILLERS,
    MOTIFS: MOTIFS,
    codes: codes,
    libelleParticipants: libelleParticipants,
    connecter: function (adaptateur) { api = adaptateur; },
    apprenant: function (profil, boite) { moi = profil; return rendreApprenant(boite); },
    equipe: function (boite, role) { return rendreEquipe(boite, role || 'admin'); },
    enAttente: nombreEnAttente
  };
})(window);
