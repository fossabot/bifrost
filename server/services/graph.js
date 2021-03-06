'use strict';

const _ = require('lodash');

const {
    graphqlExpress,
    graphiqlExpress
} = require('graphql-server-express');

const bodyParser = require('body-parser');

const featureContext = {};

const features = require('../util/features');

if (features.has('plebiscite')) {
    _.assign(featureContext, {
        plebiscite: require('../features/plebiscite')
    });
}

const querySchema = require('../graph');

const Connector = require('../graph/storage/connector');
const {Substances} = require('../graph/storage/models');

const SMWDataArbitrator = require('../graph/helpers/smwDataArbitrator');
const smwDataArbitrator = new SMWDataArbitrator();

const PWPropParser = require('../graph/helpers/pwPropParser');

const pwPropParser = new PWPropParser({
    smwDataArbitrator
});

module.exports = function* ({app, log}) {
    const baseQuerySchema = querySchema({log});

    app.get('/', graphiqlExpress({
        endpointURL: '/',

        tracing: true,
        cacheControl: true,

        query:
`{
    # Welcome to the PsychonautWiki API!
    #
    # To learn more about individual fields,
    # keep 'ctrl' (Windows) or 'cmd' (macOS)
    # pressed and click the field name. This
    # will open the respective documentation
    # entry in a sidebar on the right.
    #
    # If you have any questions or found an
    # issue or any bug, don't hesitate to
    # contact Kenan (kenan@dtr.is).
    #
    # Happy hacking!

    substances(query: "Armodafinil") {
        name

        # routes of administration
        roas {
            name

            dose {
                units
                threshold
                heavy
                common { min max }
                light { min max }
                strong { min max }
            }

            duration {
                afterglow { min max units }
                comeup { min max units }
                duration { min max units }
                offset { min max units }
                onset { min max units }
                peak { min max units }
                total { min max units }
            }

            bioavailability {
                min max
            }
        }

        # subjective effects
        effects {
            name url
        }
    }
}`
    }));

    app.post('/', bodyParser.json(), (req, res, next) =>
        graphqlExpress({
            schema: baseQuerySchema.schema,
            rootValue: baseQuerySchema.root(req, res),
            context: _.assign({}, {
                substances: new Substances({
                    connector: new Connector({log}),
                    pwPropParser,
                    log
                })
            }, featureContext)
        })(req, res, next)
    );
};
