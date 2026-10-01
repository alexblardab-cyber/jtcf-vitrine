/* ==========================================================================
   JTCF — LE PIED DE PAGE
   --------------------------------------------------------------------------
   La signature, au même endroit sur toutes les pages des trois applications.

   ► POUR L'AJOUTER À UNE PAGE
     Une seule ligne, juste avant la balise </body> :

         <script src="pied.js"></script>

     Rien d'autre. Le pied s'ajoute tout seul, en bas, et ne gêne rien.

   ► POUR CHANGER LA MENTION
     Modifier MENTION ci-dessous, redéposer ce fichier : toutes les pages
     des trois applications sont à jour d'un coup.

   ► L'ANNÉE
     Elle se met à jour toute seule chaque 1er janvier. Rien à faire.
   ========================================================================== */

(function () {
  'use strict';

  var AUTEUR    = 'Alexandre Blard';
  var ORGANISME = 'JT Conseil Formation';
  var ANNEE     = new Date().getFullYear();

  var MENTION = '© ' + ANNEE + ' ' + ORGANISME
              + ' — Conçu et développé par ' + AUTEUR
              + ' — Tous droits réservés.';

  // Une page peut refuser le pied en posant data-sans-pied sur <body>.
  // Utile pour un écran de projection ou une page d'impression.
  if (document.body && document.body.hasAttribute('data-sans-pied')) return;

  function poser() {
    if (document.getElementById('jtcfPied')) return;   // jamais deux fois

    var pied = document.createElement('footer');
    pied.id = 'jtcfPied';
    pied.setAttribute('role', 'contentinfo');
    pied.textContent = MENTION;

    pied.style.cssText = [
      'margin-top:32px',
      'padding:16px 20px calc(16px + env(safe-area-inset-bottom))',
      'text-align:center',
      'font-size:12px',
      'line-height:1.5',
      'color:#718096',
      'border-top:1px solid rgba(0,0,0,.08)',
      'font-family:inherit',
      'user-select:none'
    ].join(';');

    document.body.appendChild(pied);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', poser);
  } else {
    poser();
  }
})();
