document.addEventListener("DOMContentLoaded", function () {

    /* =====================================================
       CURRENT PAGE NAVIGATION
    ====================================================== */

    const currentPage =
        window.location.pathname.split("/").pop() || "index.html";


    const navLinks =
        document.querySelectorAll(".nav-link");


    navLinks.forEach(function (link) {

        const linkPage =
            link.getAttribute("href");


        link.classList.remove("active");


        if (
            linkPage === currentPage ||
            (
                currentPage === "" &&
                linkPage === "index.html"
            )
        ) {

            link.classList.add("active");

        }

    });


    /* =====================================================
       TABLE ROW CLICK FEEDBACK
       OPTIONAL DEMO BEHAVIOR
    ====================================================== */

    const tableRows =
        document.querySelectorAll("tbody tr");


    tableRows.forEach(function (row) {

        row.addEventListener("mouseenter", function () {

            row.style.backgroundColor =
                "#fafbfc";

        });


        row.addEventListener("mouseleave", function () {

            row.style.backgroundColor =
                "";

        });

    });


    /* =====================================================
       DEMO BUTTON FEEDBACK
    ====================================================== */

    const buttons =
        document.querySelectorAll("button");


    buttons.forEach(function (button) {

        button.addEventListener("click", function () {

            const text =
                button.textContent.trim();


            console.log(
                "StockVelocity action:",
                text
            );

        });

    });

});
