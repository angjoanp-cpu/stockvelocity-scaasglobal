document.addEventListener("DOMContentLoaded", function () {

    /* =====================================================
       STOCKVELOCITY SAMPLE MASTER DATA
    ====================================================== */

    const defaultProducts = [

        {
            sku: "FG-100",
            product: "Core Product A",

            shopify: 120,
            amazon: 80,
            wholesale: 50,

            leadTime: 30,
            reviewPeriod: 14,
            safetyStock: 60,

            available: 185,
            incoming: 100,

            targetInventory: 560
        },

        {
            sku: "FG-101",
            product: "Core Product B",

            shopify: 90,
            amazon: 110,
            wholesale: 30,

            leadTime: 45,
            reviewPeriod: 14,
            safetyStock: 75,

            available: 420,
            incoming: 200,

            targetInventory: 620
        },

        {
            sku: "FG-102",
            product: "Core Product C",

            shopify: 160,
            amazon: 70,
            wholesale: 20,

            leadTime: 60,
            reviewPeriod: 14,
            safetyStock: 100,

            available: 240,
            incoming: 0,

            targetInventory: 850
        },

        {
            sku: "FG-103",
            product: "Core Product D",

            shopify: 70,
            amazon: 40,
            wholesale: 20,

            leadTime: 30,
            reviewPeriod: 14,
            safetyStock: 35,

            available: 170,
            incoming: 50,

            targetInventory: 220
        },

        {
            sku: "FG-104",
            product: "Core Product E",

            shopify: 50,
            amazon: 30,
            wholesale: 10,

            leadTime: 21,
            reviewPeriod: 14,
            safetyStock: 25,

            available: 70,
            incoming: 40,

            targetInventory: 110
        }

    ];


    /* =====================================================
       STORAGE
    ====================================================== */

    function getProducts() {

        const stored =
            localStorage.getItem("stockVelocityProducts");


        if (!stored) {

            localStorage.setItem(
                "stockVelocityProducts",
                JSON.stringify(defaultProducts)
            );

            return defaultProducts;
        }


        return JSON.parse(stored);

    }


    function saveProducts(products) {

        localStorage.setItem(
            "stockVelocityProducts",
            JSON.stringify(products)
        );

    }


    let products = getProducts();


    /* =====================================================
       CALCULATIONS
    ====================================================== */

    function calculateDemand(product) {

        return (
            Number(product.shopify) +
            Number(product.amazon) +
            Number(product.wholesale)
        );

    }


    function calculateDailyDemand(product) {

        return calculateDemand(product) / 30;

    }


    function calculateDOLT(product) {

        const dailyDemand =
            calculateDailyDemand(product);


        const dolt =
            dailyDemand *
            (
                Number(product.leadTime) +
                Number(product.reviewPeriod)
            );


        return Math.round(dolt);

    }


    function calculateROP(product) {

        const dailyDemand =
            calculateDailyDemand(product);


        const rop =
            (
                dailyDemand *
                Number(product.leadTime)
            ) +
            Number(product.safetyStock);


        return Math.round(rop);

    }


    function calculateExpectedInventory(product) {

        return (
            Number(product.available) +
            Number(product.incoming)
        );

    }


    function calculateRecommendedOrder(product) {

        const expected =
            calculateExpectedInventory(product);


        const requirement =
            Number(product.targetInventory);


        return Math.max(
            0,
            requirement - expected
        );

    }


    function calculateInventoryStatus(product) {

        const expected =
            calculateExpectedInventory(product);


        const rop =
            calculateROP(product);


        if (expected <= rop) {

            return "Order Now";

        }


        if (expected <= rop * 1.15) {

            return "Order Soon";

        }


        return "Healthy";

    }


    /* =====================================================
       NAVIGATION ACTIVE STATE
    ====================================================== */

    const currentPage =
        window.location.pathname.split("/").pop() ||
        "index.html";


    const navLinks =
        document.querySelectorAll(".nav-link");


    navLinks.forEach(function (link) {

        link.classList.remove("active");


        if (
            link.getAttribute("href") ===
            currentPage
        ) {

            link.classList.add("active");

        }

    });


    /* =====================================================
       DEMAND PLANNING PAGE
    ====================================================== */

    const demandTableBody =
        document.getElementById(
            "demand-table-body"
        );


    if (demandTableBody) {

        renderDemandPlanning();

    }


    function renderDemandPlanning() {

        demandTableBody.innerHTML = "";


        products.forEach(function (
            product,
            index
        ) {

            const totalDemand =
                calculateDemand(product);


            const dolt =
                calculateDOLT(product);


            const rop =
                calculateROP(product);


            const row =
                document.createElement("tr");


            row.innerHTML = `

                <td>
                    ${product.sku}
                </td>

                <td>
                    ${product.product}
                </td>

                <td>
                    <input
                        class="table-input demand-input"
                        type="number"
                        min="0"
                        data-index="${index}"
                        data-field="shopify"
                        value="${product.shopify}"
                    >
                </td>

                <td>
                    <input
                        class="table-input demand-input"
                        type="number"
                        min="0"
                        data-index="${index}"
                        data-field="amazon"
                        value="${product.amazon}"
                    >
                </td>

                <td>
                    <input
                        class="table-input demand-input"
                        type="number"
                        min="0"
                        data-index="${index}"
                        data-field="wholesale"
                        value="${product.wholesale}"
                    >
                </td>

                <td class="calculated-value">
                    ${totalDemand}
                </td>

                <td>
                    ${product.leadTime} days
                </td>

                <td>
                    ${product.reviewPeriod} days
                </td>

                <td>
                    ${product.safetyStock}
                </td>

                <td class="calculated-value">
                    ${dolt}
                </td>

                <td class="calculated-value">
                    ${rop}
                </td>

            `;


            demandTableBody.appendChild(row);

        });


        updateDemandKPIs();

        bindDemandInputs();

    }


    function bindDemandInputs() {

        const inputs =
            document.querySelectorAll(
                ".demand-input"
            );


        inputs.forEach(function (input) {

            input.addEventListener(
                "input",
                function () {

                    const index =
                        Number(
                            input.dataset.index
                        );


                    const field =
                        input.dataset.field;


                    products[index][field] =
                        Number(input.value) || 0;


                    saveProducts(products);


                    renderDemandPlanning();

                }
            );

        });

    }


    function updateDemandKPIs() {

        let totalDemand = 0;
        let shopify = 0;
        let amazon = 0;
        let wholesale = 0;


        products.forEach(function (product) {

            totalDemand +=
                calculateDemand(product);

            shopify +=
                Number(product.shopify);

            amazon +=
                Number(product.amazon);

            wholesale +=
                Number(product.wholesale);

        });


        setText(
            "total-demand-kpi",
            totalDemand
        );

        setText(
            "shopify-demand-kpi",
            shopify
        );

        setText(
            "amazon-demand-kpi",
            amazon
        );

        setText(
            "wholesale-demand-kpi",
            wholesale
        );

    }


    /* =====================================================
       INVENTORY PLANNING PAGE
    ====================================================== */

    const inventoryTableBody =
        document.getElementById(
            "inventory-table-body"
        );


    if (inventoryTableBody) {

        renderInventoryPlanning();

    }


    function renderInventoryPlanning() {

        inventoryTableBody.innerHTML = "";


        products.forEach(function (
            product,
            index
        ) {

            const forecast =
                calculateDemand(product);


            const expected =
                calculateExpectedInventory(product);


            const rop =
                calculateROP(product);


            const recommended =
                calculateRecommendedOrder(product);


            const status =
                calculateInventoryStatus(product);


            let statusClass =
                "healthy";


            if (status === "Order Now") {

                statusClass =
                    "danger";

            }


            if (status === "Order Soon") {

                statusClass =
                    "warning";

            }


            const row =
                document.createElement("tr");


            row.innerHTML = `

                <td>
                    ${product.sku}
                </td>

                <td>
                    ${product.product}
                </td>

                <td>
                    <input
                        class="table-input inventory-input"
                        type="number"
                        min="0"
                        data-index="${index}"
                        data-field="available"
                        value="${product.available}"
                    >
                </td>

                <td>
                    <input
                        class="table-input inventory-input"
                        type="number"
                        min="0"
                        data-index="${index}"
                        data-field="incoming"
                        value="${product.incoming}"
                    >
                </td>

                <td class="calculated-value">
                    ${expected}
                </td>

                <td class="calculated-value">
                    ${forecast}
                </td>

                <td class="calculated-value">
                    ${rop}
                </td>

                <td class="calculated-value">
                    ${recommended}
                </td>

                <td>
                    <span
                        class="status ${statusClass}"
                    >
                        ${status}
                    </span>
                </td>

            `;


            inventoryTableBody.appendChild(row);

        });


        updateInventoryKPIs();

        bindInventoryInputs();

    }


    function bindInventoryInputs() {

        const inputs =
            document.querySelectorAll(
                ".inventory-input"
            );


        inputs.forEach(function (input) {

            input.addEventListener(
                "input",
                function () {

                    const index =
                        Number(
                            input.dataset.index
                        );


                    const field =
                        input.dataset.field;


                    products[index][field] =
                        Number(input.value) || 0;


                    saveProducts(products);


                    renderInventoryPlanning();

                }
            );

        });

    }


    function updateInventoryKPIs() {

        let incoming = 0;

        let orderNow = 0;

        let healthy = 0;


        products.forEach(function (product) {

            incoming +=
                Number(product.incoming);


            const status =
                calculateInventoryStatus(product);


            if (status === "Order Now") {

                orderNow++;

            }


            if (status === "Healthy") {

                healthy++;

            }

        });


        setText(
            "incoming-kpi",
            incoming
        );

        setText(
            "order-now-kpi",
            orderNow
        );

        setText(
            "healthy-kpi",
            healthy
        );

    }


    /* =====================================================
       RESET DEMO DATA
    ====================================================== */

    const resetButton =
        document.getElementById(
            "reset-demo-data"
        );


    if (resetButton) {

        resetButton.addEventListener(
            "click",
            function () {

                const confirmed =
                    window.confirm(
                        "Reset StockVelocity sample data?"
                    );


                if (!confirmed) {
                    return;
                }


                localStorage.setItem(
                    "stockVelocityProducts",
                    JSON.stringify(
                        defaultProducts
                    )
                );


                window.location.reload();

            }
        );

    }


    /* =====================================================
       HELPERS
    ====================================================== */

    function setText(
        id,
        value
    ) {

        const element =
            document.getElementById(id);


        if (element) {

            element.textContent =
                value;

        }

    }

});
const vendors = [
    {
        id: "VEN-001",
        name: "Supplier A",
        city: "Shenzhen",
        country: "China",
        currency: "USD",
        leadTime: 30,
        paymentTerms: "30% / 70%",
        otd: 94,
        quality: 98
    },

    {
        id: "VEN-002",
        name: "Supplier B",
        city: "Ho Chi Minh City",
        country: "Vietnam",
        currency: "USD",
        leadTime: 45,
        paymentTerms: "Net 30",
        otd: 97,
        quality: 99
    },

    {
        id: "VEN-003",
        name: "Supplier C",
        city: "California",
        country: "USA",
        currency: "USD",
        leadTime: 18,
        paymentTerms: "Net 30",
        otd: 89,
        quality: 96
    },

    {
        id: "VEN-004",
        name: "Supplier D",
        city: "Taipei",
        country: "Taiwan",
        currency: "USD",
        leadTime: 35,
        paymentTerms: "Net 30",
        otd: 82,
        quality: 94
    }
];
