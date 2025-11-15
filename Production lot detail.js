import url from 'url';
import { createRunner } from '@puppeteer/replay';

export async function run(extension) {
    const runner = await createRunner(extension);

    await runner.runBeforeAllSteps();

    await runner.runStep({
        type: 'setViewport',
        width: 960,
        height: 686,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        isLandscape: false
    });
    await runner.runStep({
        type: 'navigate',
        url: 'http://127.0.0.1:5000/upf/production-lot/124',
        assertedEvents: [
            {
                type: 'navigation',
                url: 'http://127.0.0.1:5000/upf/production-lot/124',
                title: 'Production Lot Detail'
            }
        ]
    });
    await runner.runStep({
        type: 'click',
        target: 'main',
        selectors: [
            [
                '#subprocesses-content button'
            ],
            [
                'xpath///*[@id="subprocesses-content"]/div/div[1]/div[2]/button'
            ],
            [
                'pierce/#subprocesses-content button'
            ],
            [
                'aria/+ Add Variant'
            ]
        ],
        offsetY: 7.024993896484375,
        offsetX: 60,
    });
    await runner.runStep({
        type: 'click',
        target: 'main',
        selectors: [
            [
                '#header-add-variant-btn'
            ],
            [
                'xpath///*[@id="header-add-variant-btn"]'
            ],
            [
                'pierce/#header-add-variant-btn'
            ],
            [
                'aria/Add Variant'
            ]
        ],
        offsetY: 19.64996337890625,
        offsetX: 84.5625,
    });
    await runner.runStep({
        type: 'click',
        target: 'main',
        selectors: [
            [
                '#subprocess-select-for-add'
            ],
            [
                'xpath///*[@id="subprocess-select-for-add"]'
            ],
            [
                'pierce/#subprocess-select-for-add'
            ],
            [
                'aria/[role="main"]',
                'aria/[role="combobox"]'
            ]
        ],
        offsetY: 3.94464111328125,
        offsetX: 210.5625,
    });
    await runner.runStep({
        type: 'change',
        value: '',
        selectors: [
            [
                '#subprocess-select-for-add'
            ],
            [
                'xpath///*[@id="subprocess-select-for-add"]'
            ],
            [
                'pierce/#subprocess-select-for-add'
            ],
            [
                'aria/[role="main"]',
                'aria/[role="combobox"]'
            ]
        ],
        target: 'main'
    });
    await runner.runStep({
        type: 'click',
        target: 'main',
        selectors: [
            [
                '#subprocess-select-for-add'
            ],
            [
                'xpath///*[@id="subprocess-select-for-add"]'
            ],
            [
                'pierce/#subprocess-select-for-add'
            ],
            [
                'aria/[role="main"]',
                'aria/[role="combobox"]'
            ]
        ],
        offsetY: 11.25,
        offsetX: 215.5625,
    });
    await runner.runStep({
        type: 'change',
        value: '6',
        selectors: [
            [
                '#subprocess-select-for-add'
            ],
            [
                'xpath///*[@id="subprocess-select-for-add"]'
            ],
            [
                'pierce/#subprocess-select-for-add'
            ],
            [
                'aria/[role="main"]',
                'aria/[role="combobox"]'
            ]
        ],
        target: 'main'
    });
    await runner.runStep({
        type: 'click',
        target: 'main',
        selectors: [
            [
                '#header-add-variant-btn'
            ],
            [
                'xpath///*[@id="header-add-variant-btn"]'
            ],
            [
                'pierce/#header-add-variant-btn'
            ],
            [
                'aria/Add Variant'
            ]
        ],
        offsetY: 28.64996337890625,
        offsetX: 107.5625,
    });

    await runner.runAfterAllSteps();
}

if (process && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
    run()
}
