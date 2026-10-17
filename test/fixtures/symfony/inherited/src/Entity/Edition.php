<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

// Redeclares the name of its parent and the code of its trait: its own mapping wins
#[ORM\Entity]
class Edition extends AbstractNamed
{
    use HasCode;

    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;

    #[ORM\Column(name: 'label', type: 'text')]
    protected ?string $name = null;

    #[ORM\Column(name: 'isbn', length: 13)]
    private ?string $code = null;
}
