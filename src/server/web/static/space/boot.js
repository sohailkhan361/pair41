// Entry point of the 3D layer. Starts the landing hero or, on logged-in pages, the backdrop and the 3D live views.
// Tells sim.js how it went ("pair41:space"), so the 2D views run when WebGL 2 is missing or anything here fails.
import { hasWebGL2 } from './core.js';

const doc = document;
const html = doc.documentElement;

function done(ok) {
  window.PAIR41_SPACE = ok;
  doc.dispatchEvent(new window.CustomEvent('pair41:space', { detail: { ok } }));
}

async function boot() {
  // sim.js gave up waiting and started the 2D views: leave them be.
  if (window.PAIR41_2D || !hasWebGL2()) return done(false);
  try {
    const hero = doc.getElementById('space-hero');
    if (hero) {
      // Hide the 2D demo before the first frame, so the two never show at once.
      doc.querySelectorAll('canvas[data-demo]').forEach((c) => (c.dataset.space = 'on'));
      html.classList.add('space-on');
      const { initHero } = await import('./hero.js');
      await initHero(hero);
    } else {
      const [{ initBackdrop }, { initAgents }] = await Promise.all([
        import('./backdrop.js'),
        import('./agents.js'),
      ]);
      initBackdrop();
      initAgents();
      html.classList.add('space-on');
    }
    done(true);
  } catch (error) {
    console.error('Pair41 3D layer failed; using the 2D views.', error);
    html.classList.remove('space-on');
    doc.querySelectorAll('canvas[data-space="on"]').forEach((c) => {
      delete c.dataset.space;
      c.hidden = false;
    });
    done(false);
  }
}

boot();
