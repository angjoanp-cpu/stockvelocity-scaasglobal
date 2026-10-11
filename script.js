/* =====================================
   STOCKVELOCITY NAVIGATION
===================================== */

const navLinks = document.querySelectorAll(".nav-link");

const pages = document.querySelectorAll(".page");

const pageTitle = document.getElementById("page-title");


navLinks.forEach(function (link) {

    link.addEventListener("click", function () {

        const targetPage = link.dataset.page;


        /* Remove active navigation */

        navLinks.forEach(function (item) {

            item.classList.remove("active");

        });


        /* Activate clicked navigation */

        link.classList.add("active");


        /* Hide every page */

        pages.forEach(function (page) {

            page.classList.remove("active");

        });


        /* Find selected page */

        const selectedPage =
            document.getElementById(targetPage);


        /* Show selected page */

        if (selectedPage) {

            selectedPage.classList.add("active");

        }


        /* Update page title */

        pageTitle.textContent =
            link.textContent.trim();

    });

});
