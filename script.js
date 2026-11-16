const menuButton = document.querySelector('.menu-button');
const nav = document.querySelector('#main-nav');

menuButton?.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
});

nav?.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    nav.classList.remove('open');
    menuButton?.setAttribute('aria-expanded', 'false');
  });
});

// Collapse the mobile navigation only once its controls are ready.
document.documentElement.classList.add('js-enabled');

document.querySelector('#year').textContent = new Date().getFullYear();
