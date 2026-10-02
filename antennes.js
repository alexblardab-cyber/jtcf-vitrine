/* ==========================================================================
   JTCF — LES ANTENNES
   --------------------------------------------------------------------------
   UN SEUL FICHIER pour tout ce qui change d'un territoire à l'autre :
   l'adresse, le référent, le courriel, le téléphone, les communes couvertes.

   Les trois applications y puisent :
     · l'application alternance  → pour router les rendez-vous
     · le positionnement         → pour envoyer le résultat au bon référent
     · la vitrine                → pour afficher les coordonnées

   ► POUR OUVRIR OU FERMER UNE ANTENNE
     Le champ  ouvert  commande tout. À false, l'antenne s'affiche en
     « bientôt » : visible, mais aucun rendez-vous ne peut lui être demandé,
     et les dossiers du territoire reviennent au Sud. À true, elle est
     pleinement active. Déposer ce fichier suffit : la vitrine, le test de
     positionnement et les rendez-vous se mettent à jour d'un coup.
   ========================================================================== */

(function (global) {
  'use strict';

  var ANTENNES = {

    /* ═══ SUD — Saint-Joseph ═══════════════════════════════════════════════ */
    sud: {
      ouvert: true,
      nom: 'JTCF Sud',
      ville: 'Saint-Joseph',
      adresse: '20a rue du Général Lambert',
      codePostal: '97480',
      commune: 'Saint-Joseph',
      telephone: '06 92 33 47 88',
      courriel: 'contact@tbrgroup.fr',

      // Le territoire couvert, tel qu'on le dit aux candidats.
      libelle: 'Sud',
      couvre: 'Saint-Joseph, Saint-Pierre, Le Tampon, Saint-Louis, Petite-Île, Saint-Philippe, '
            + 'Entre-Deux, L\'Étang-Salé, Cilaos, Les Avirons',

      // Les codes des conseillers de rdv.js qui reçoivent ici.
      // Le premier de la liste est celui vers qui partent les demandes
      // du public extérieur.
      conseillers: ['AB', 'MG'],

      couleur: '#2C6E9B'
    },

    /* ═══ NORD–EST–OUEST — Saint-Denis ═════════════════════════════════════
       Ouverte le 2 octobre 2026. Référent : Gabriel Go.                     */
    nord: {
      ouvert: true,

      nom: 'JTCF Nord',
      ville: 'Saint-Denis',
      adresse: '27 rue du Bois de Nèfles',
      codePostal: '97400',
      commune: 'Saint-Denis',
      telephone: '06 93 86 98 44',
      courriel: 'commercial.go@tbrgroup.fr',   // Gabriel Go, référent Nord

      libelle: 'Nord, Est et Ouest',
      couvre: 'Saint-Denis, Sainte-Marie, Sainte-Suzanne, Saint-André, Bras-Panon, '
            + 'Saint-Benoît, La Plaine-des-Palmistes, Sainte-Rose, Salazie, '
            + 'Saint-Paul, Le Port, La Possession, Saint-Leu, Trois-Bassins',

      conseillers: ['GG'],               // Gabriel Go

      couleur: '#2f855a'
    }
  };

  /* ---- Lecture ----------------------------------------------------------- */

  function liste() {
    return Object.keys(ANTENNES).map(function (id) {
      var a = ANTENNES[id];
      return {
        id: id, ouvert: a.ouvert, nom: a.nom, libelle: a.libelle,
        ville: a.ville, couleur: a.couleur
      };
    });
  }

  // Celles où l'on peut réellement prendre rendez-vous aujourd'hui.
  function ouvertes() {
    return liste().filter(function (a) { return a.ouvert; });
  }

  function get(id) { return ANTENNES[id] || null; }

  // Le conseiller vers qui envoyer une demande venue du public.
  function referent(id) {
    var a = ANTENNES[id];
    if (!a || !a.ouvert) return null;
    return (a.conseillers && a.conseillers[0]) || null;
  }

  function courrielDe(id) {
    var a = ANTENNES[id];
    return (a && a.courriel) || 'contact@tbrgroup.fr';
  }

  // L'adresse en une ligne, pour un courriel ou une carte.
  function adresseComplete(id) {
    var a = ANTENNES[id];
    if (!a) return '';
    if (!a.ouvert) return a.note || '';
    return a.adresse + ', ' + a.codePostal + ' ' + a.commune;
  }

  // À quelle antenne rattacher quelqu'un, d'après sa commune.
  // Repli sur le Sud : c'est historiquement le siège.
  function antenneDe(commune) {
    var c = String(commune || '').toLowerCase();
    if (!c) return 'sud';
    var ids = Object.keys(ANTENNES);
    for (var i = 0; i < ids.length; i++) {
      var couvre = String(ANTENNES[ids[i]].couvre || '').toLowerCase();
      var villes = couvre.split(',').map(function (v) { return v.trim(); });
      for (var j = 0; j < villes.length; j++) {
        if (villes[j] && c.indexOf(villes[j]) >= 0) return ids[i];
      }
    }
    return 'sud';
  }

  // Les communes de chaque antenne, dans l'ordre alphabétique.
  function communes(id) {
    var a = ANTENNES[id];
    if (!a) return [];
    return String(a.couvre || '').split(',')
      .map(function (v) { return v.trim(); })
      .filter(Boolean)
      .sort(function (x, y) { return x.localeCompare(y, 'fr'); });
  }

  // Les options prêtes à poser dans une liste déroulante.
  function options(seulementOuvertes) {
    return (seulementOuvertes ? ouvertes() : liste()).map(function (a) {
      return [a.id, a.libelle + (a.ouvert ? '' : ' — bientôt')];
    });
  }

  global.JTCF_ANTENNES = {
    ANTENNES: ANTENNES,
    liste: liste,
    communes: communes,
    ouvertes: ouvertes,
    get: get,
    referent: referent,
    courrielDe: courrielDe,
    adresseComplete: adresseComplete,
    antenneDe: antenneDe,
    options: options
  };

})(window);
